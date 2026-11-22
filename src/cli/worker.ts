import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { loadConfig, type ConfigDeps, type CouncilConfig } from "../core/config.js";
import { cancelRequested, jobsDir, writeJobState } from "../core/detached.js";
import type { DeliberateInput } from "../core/deliberate.js";
import type { CouncilEvent } from "../core/events.js";
import { ProgressTracker } from "../core/output/progress.js";
import type { ParticipantDriver } from "../core/participant.js";
import type { DeliberationResult } from "../core/types.js";
import { WorkflowMachine } from "../core/workflow/machine.js";
import { applyModels, runDeliberationTask, runPhaseTask, type WorkerSpec } from "../mcp/runtime.js";

/**
 * Рабочий процесс совета: `council worker --spec <файл>`. Запускается MCP-сервером отвязанным
 * (своя группа процессов), поэтому переживает перезапуск MCP-сервера хостом. Состояние и
 * итог — в `.council/jobs/<run_id>.state.json`, отмена — файл `<run_id>.cancel`.
 */

const KEEP_DAYS = 7;

/** MCP-сервер: записать задание и запустить отвязанный рабочий процесс; вернуть pid. */
export function spawnWorker(
  bundlePath: string,
  spec: WorkerSpec,
  config: CouncilConfig,
): number | undefined {
  const dir = jobsDir(config.paths.stateDir);
  mkdirSync(dir, { recursive: true });
  pruneJobs(dir);
  const specPath = join(dir, `${spec.runId}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const log = openSync(join(dir, `${spec.runId}.log`), "a", 0o600);
  try {
    const child = spawn(process.execPath, [bundlePath, "worker", "--spec", specPath], {
      cwd: config.workspace,
      env: process.env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/** Файлы запусков старше недели (итог остаётся в транскрипте .council/runs). */
function pruneJobs(dir: string): void {
  const limit = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < limit) rmSync(path, { force: true });
    } catch {
      // файл уже удалён
    }
  }
}

export async function runWorker(
  argv: string[],
  deps: { configDeps: () => ConfigDeps; makeDriver: (config: CouncilConfig) => ParticipantDriver },
): Promise<number> {
  const i = argv.indexOf("--spec");
  const specPath = i >= 0 ? argv[i + 1] : undefined;
  if (!specPath) {
    process.stderr.write("council worker --spec <файл>\n");
    return 2;
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as WorkerSpec;
  rmSync(specPath, { force: true });
  const config = applyModels(loadConfig(deps.configDeps()), spec.models);
  const stateDir = config.paths.stateDir;
  const runId = spec.runId;
  const tracker = new ProgressTracker(Date.now, runId);
  const controller = new AbortController();
  const write = (
    status: "running" | "done" | "failed" | "cancelled",
    extra: { result?: DeliberationResult; error?: string } = {},
  ) => {
    writeJobState(stateDir, {
      runId,
      status,
      progress: tracker.render(),
      pid: process.pid,
      updatedAt: Date.now(),
      ...extra,
    });
  };
  const emit = (event: CouncilEvent) => {
    tracker.apply(event);
    write("running");
  };
  // Хост закрыл терминал — не повод бросать совет; явная остановка процесса — итог partial.
  process.on("SIGHUP", () => undefined);
  process.on("SIGTERM", () => {
    controller.abort(new Error("рабочий процесс совета остановлен (SIGTERM)"));
  });
  const timer = setInterval(() => {
    if (!controller.signal.aborted && cancelRequested(stateDir, runId))
      controller.abort(new Error("запуск отменён вызовом council_cancel"));
    write("running");
  }, 1000);

  write("running");
  const ctx = { runId, emit, signal: controller.signal };
  try {
    const result =
      spec.kind === "phase"
        ? await runPhaseTask(
            config,
            new WorkflowMachine({ config }),
            spec.workflowId ?? "",
            spec.input,
            deps.makeDriver,
            ctx,
          )
        : await runDeliberationTask(
            spec.input as DeliberateInput,
            config,
            deps.makeDriver(config),
            ctx,
          );
    clearInterval(timer);
    write(controller.signal.aborted ? "cancelled" : "done", { result });
    return 0;
  } catch (e) {
    clearInterval(timer);
    write(controller.signal.aborted ? "cancelled" : "failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return 1;
  }
}
