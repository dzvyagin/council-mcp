import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { JobSnapshot, JobStatus } from "./jobs.js";

/**
 * Запуски совета в отдельном фоновом процессе (`council worker`). Хост (opencode) свободно
 * перезапускает MCP-сервер — при правке конфига, простое, перезапуске сервиса, — и запуск,
 * живущий внутри MCP-процесса, погибал бы вместе с ним. Рабочий процесс отвязан от MCP
 * (своя группа процессов) и пишет состояние в `.council/jobs/<run_id>.state.json`; MCP-сервер
 * (любой, в том числе новый после перезапуска) читает его в council_wait, отмена — файл
 * `<run_id>.cancel`.
 */

export interface JobState<R> {
  runId: string;
  status: JobStatus;
  progress: string;
  pid?: number;
  result?: R;
  error?: string;
  updatedAt: number;
}

export function jobsDir(stateDir: string): string {
  return join(stateDir, "jobs");
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function statePath(stateDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`недопустимый run_id: ${runId}`);
  return join(jobsDir(stateDir), `${runId}.state.json`);
}

export function cancelPath(stateDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`недопустимый run_id: ${runId}`);
  return join(jobsDir(stateDir), `${runId}.cancel`);
}

/** Атомарная запись состояния (временный файл + rename): читатель не увидит половину JSON. */
export function writeJobState<R>(stateDir: string, state: JobState<R>): void {
  mkdirSync(jobsDir(stateDir), { recursive: true });
  const path = statePath(stateDir, state.runId);
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

export function readJobState<R>(stateDir: string, runId: string): JobState<R> | undefined {
  try {
    return JSON.parse(readFileSync(statePath(stateDir, runId), "utf8")) as JobState<R>;
  } catch {
    return undefined;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Снимок запуска по файлу состояния; «running» с мёртвым процессом — failed. */
export function detachedSnapshot<R>(
  stateDir: string,
  runId: string,
  alive: (pid: number) => boolean = processAlive,
): JobSnapshot<R> | undefined {
  if (!RUN_ID.test(runId)) return undefined;
  const s = readJobState<R>(stateDir, runId);
  if (!s) return undefined;
  if (s.status === "running" && s.pid !== undefined && !alive(s.pid)) {
    return {
      runId,
      status: "failed",
      progress: s.progress,
      error: "рабочий процесс совета завершился без итога (см. .council/jobs/<run_id>.log)",
    };
  }
  return {
    runId,
    status: s.status,
    progress: s.progress,
    ...(s.result !== undefined && { result: s.result }),
    ...(s.error !== undefined && { error: s.error }),
  };
}

/** Ждёт завершения не дольше waitMs, опрашивая файл состояния. */
export async function detachedWait<R>(
  stateDir: string,
  runId: string,
  waitMs: number,
  options: {
    pollMs?: number;
    alive?: (pid: number) => boolean;
    onProgress?: (p: string) => void;
  } = {},
): Promise<JobSnapshot<R> | undefined> {
  const deadline = Date.now() + waitMs;
  let last: string | undefined;
  for (;;) {
    const s = detachedSnapshot<R>(stateDir, runId, options.alive);
    if (!s) return undefined;
    if (s.progress !== last) {
      last = s.progress;
      options.onProgress?.(s.progress);
    }
    if (s.status !== "running" || Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, Math.min(options.pollMs ?? 500, deadline - Date.now())));
  }
}

/** Отмена: файл-флаг, рабочий процесс проверяет его раз в секунду. */
export function requestCancel(stateDir: string, runId: string): boolean {
  const s = detachedSnapshot(stateDir, runId);
  if (s?.status !== "running") return false;
  writeFileSync(cancelPath(stateDir, runId), String(Date.now()));
  return true;
}

export function cancelRequested(stateDir: string, runId: string): boolean {
  return existsSync(cancelPath(stateDir, runId));
}
