import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { Redactor } from "../context/redact.js";
import { ensureStateDir } from "../state/dir.js";

/**
 * Транскрипт запуска: `.council/runs/<run_id>.jsonl`, одно событие на строку.
 * Реальные имена моделей есть только здесь. Все строки маскируются до записи.
 */

export interface TranscriptEntry {
  type: "run_started" | "ask" | "run_finished";
  round?: string;
  alias?: string;
  model?: string;
  role?: string;
  prompt_hash?: string;
  usage?: unknown;
  duration_ms?: number;
  raw?: string;
  parsed?: unknown;
  error?: { kind: string; message: string };
  [key: string]: unknown;
}

export const promptHash = (prompt: string): string =>
  createHash("sha256").update(prompt).digest("hex").slice(0, 16);

export class TranscriptWriter {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;
  private failure: Error | undefined;

  constructor(
    private readonly stateDir: string,
    private readonly runId: string,
    private readonly redactor: Redactor,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(stateDir, "runs", `${runId}.jsonl`);
  }

  /** Добавляет запись; ошибки записи не роняют запуск, но видны в flush(). */
  write(entry: TranscriptEntry): void {
    const line = `${JSON.stringify(
      this.redactor.deep({ ts: new Date(this.now()).toISOString(), run_id: this.runId, ...entry }),
    )}\n`;
    this.ready ??= ensureStateDir(this.stateDir);
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => appendFile(this.path, line, "utf8"))
      .catch((e: unknown) => {
        this.failure ??= e instanceof Error ? e : new Error(String(e));
      });
  }

  /** Дождаться записи всех строк. Возвращает ошибку записи, если была. */
  async flush(): Promise<Error | undefined> {
    await this.queue;
    return this.failure;
  }
}
