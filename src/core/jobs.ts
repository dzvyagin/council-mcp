import { randomBytes } from "node:crypto";

import type { CouncilEvent, EventSink } from "./events.js";
import { ProgressTracker } from "./output/progress.js";

/**
 * Асинхронные запуски. Долгий инструмент стартует задачу и ждёт её не дольше `wait_s`;
 * не успел — хост получает снимок прогресса и продолжает ожидание отдельным вызовом.
 * Так совет работает и в хостах с коротким таймаутом инструмента (DSH — 60 с).
 */

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobSnapshot<R> {
  runId: string;
  status: JobStatus;
  /** Текст прогресса с маркерами участников. */
  progress: string;
  result?: R;
  error?: string;
}

export interface JobContext {
  runId: string;
  signal: AbortSignal;
  emit: EventSink;
}

interface Job<R> {
  runId: string;
  status: JobStatus;
  tracker: ProgressTracker;
  controller: AbortController;
  done: Promise<void>;
  result?: R;
  error?: string;
}

export interface JobRunnerOptions {
  now?: () => number;
  newRunId?: () => string;
  /** Сколько завершённых запусков держать в памяти. */
  keepFinished?: number;
  /** Внешний наблюдатель событий (логи, MCP progress). */
  onEvent?: (runId: string, event: CouncilEvent) => void;
}

export function defaultRunId(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${day}-${randomBytes(3).toString("hex")}`;
}

export class JobRunner<R> {
  private readonly jobs = new Map<string, Job<R>>();
  private readonly now: () => number;
  private readonly newRunId: () => string;
  private readonly keepFinished: number;
  private readonly onEvent: ((runId: string, event: CouncilEvent) => void) | undefined;

  constructor(options: JobRunnerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newRunId = options.newRunId ?? (() => defaultRunId(new Date(this.now())));
    this.keepFinished = options.keepFinished ?? 50;
    this.onEvent = options.onEvent;
  }

  start(task: (ctx: JobContext) => Promise<R>): string {
    let runId = this.newRunId();
    while (this.jobs.has(runId)) runId = this.newRunId();

    const controller = new AbortController();
    const tracker = new ProgressTracker(this.now);
    const job: Job<R> = {
      runId,
      status: "running",
      tracker,
      controller,
      done: Promise.resolve(),
    };
    const emit: EventSink = (event) => {
      tracker.apply(event);
      this.onEvent?.(runId, event);
    };

    // Задача стартует синхронно: отмена сразу после start() дойдёт до её обработчиков.
    const running = (async () => task({ runId, signal: controller.signal, emit }))();
    job.done = running
      .then(
        (result) => {
          job.result = result;
          job.status = controller.signal.aborted ? "cancelled" : "done";
        },
        (error: unknown) => {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.error = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        this.prune();
      });

    this.jobs.set(runId, job);
    return runId;
  }

  snapshot(runId: string): JobSnapshot<R> | undefined {
    const job = this.jobs.get(runId);
    if (!job) return undefined;
    return {
      runId,
      status: job.status,
      progress: job.tracker.render(),
      ...(job.result !== undefined && { result: job.result }),
      ...(job.error !== undefined && { error: job.error }),
    };
  }

  /** Ждёт завершения не дольше `waitMs` и возвращает снимок. */
  async wait(runId: string, waitMs: number): Promise<JobSnapshot<R> | undefined> {
    const job = this.jobs.get(runId);
    if (!job) return undefined;
    if (job.status === "running" && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        job.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.snapshot(runId);
  }

  /** Отменяет запуск. Задача сама решает, что успеть сохранить (статус partial). */
  cancel(runId: string): boolean {
    const job = this.jobs.get(runId);
    if (job?.status !== "running") return false;
    job.controller.abort(new Error("запуск отменён"));
    return true;
  }

  /** Отменить все запуски и дождаться их завершения (остановка сервера). */
  async shutdown(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === "running") job.controller.abort(new Error("сервер остановлен"));
    }
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - this.keepFinished))) {
      this.jobs.delete(job.runId);
    }
  }
}
