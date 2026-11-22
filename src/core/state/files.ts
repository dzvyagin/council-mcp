import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { ensureStateDir } from "./dir.js";

/**
 * Служебные файлы `.council/`: decisions.json (индекс решений) и integrity.json (SHA-256 файлов
 * результатов для аудита). Запись атомарная (tmp + rename), изменения внутри процесса — по очереди.
 */

const locks = new Map<string, Promise<unknown>>();

/** Последовательные read-modify-write одного файла внутри процесса. */
export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export interface DecisionEntry {
  run_id: string;
  date: string;
  mode: string;
  question: string;
  status: string;
  score: number;
  gate_passed: boolean;
  adr_path?: string;
  workflow_id?: string;
}

export async function recordDecision(stateDir: string, entry: DecisionEntry): Promise<void> {
  const path = join(stateDir, "decisions.json");
  await withLock(path, async () => {
    await ensureStateDir(stateDir);
    const data = await readJson<{ decisions: DecisionEntry[] }>(path, { decisions: [] });
    data.decisions = [...data.decisions.filter((d) => d.run_id !== entry.run_id), entry];
    await writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  });
}

export async function readDecisions(stateDir: string): Promise<DecisionEntry[]> {
  return (
    await readJson<{ decisions: DecisionEntry[] }>(join(stateDir, "decisions.json"), {
      decisions: [],
    })
  ).decisions;
}

export const sha256 = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

/** Хэши файлов результатов (ADR, транскрипт, PLAN.md) относительно workspace. */
export async function recordIntegrity(
  stateDir: string,
  workspace: string,
  files: string[],
): Promise<void> {
  const path = join(stateDir, "integrity.json");
  await withLock(path, async () => {
    await ensureStateDir(stateDir);
    const data = await readJson<{ files: Record<string, { sha256: string; updated: string }> }>(
      path,
      { files: {} },
    );
    for (const file of files) {
      try {
        data.files[relative(workspace, file)] = {
          sha256: sha256(await readFile(file)),
          updated: new Date().toISOString(),
        };
      } catch {
        // файла нет — пропускаем
      }
    }
    await writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  });
}
