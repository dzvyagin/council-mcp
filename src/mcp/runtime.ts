import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Logger } from "pino";

import { ConfigError, loadConfig, type ConfigDeps, type CouncilConfig } from "../core/config.js";
import {
  BudgetError,
  deliberate,
  InputError,
  planRun,
  type DeliberateInput,
} from "../core/deliberate.js";
import type { Check } from "../core/doctor.js";
import { renderEstimate } from "../core/estimate.js";
import type { CouncilEvent } from "../core/events.js";
import { defaultRunId, JobRunner, type JobSnapshot } from "../core/jobs.js";
import type { ParticipantDriver } from "../core/participant.js";
import { renderReport } from "../core/output/report.js";
import type { DeliberationResult } from "../core/types.js";
import {
  WorkflowError,
  WorkflowMachine,
  type PhaseInput,
  type PhaseRunner,
} from "../core/workflow/machine.js";
import type { WorkflowState } from "../core/workflow/state.js";

/**
 * Состояние MCP-сервера: конфиг (или ошибка конфига — сервер всё равно стартует, чтобы агент
 * мог показать пользователю, чего не хватает), запуски и подписки на их прогресс.
 */

export interface RuntimeOptions {
  configDeps: () => ConfigDeps;
  makeDriver: (config: CouncilConfig) => ParticipantDriver;
  logger: Logger;
  /** Для council_doctor: проверка агента-участника и поиск программ в PATH. */
  checkAgent?: (config: CouncilConfig) => Promise<Check[]>;
  which?: (command: string) => string | undefined;
  /** Абсолютный путь к бандлу (prompt setup). */
  bundlePath?: string;
  now?: () => number;
  newRunId?: () => string;
}

export type ConfigState = { ok: true; config: CouncilConfig } | { ok: false; error: string };

type Listener = (event: CouncilEvent) => void;

export class CouncilRuntime {
  readonly jobs: JobRunner<DeliberationResult>;
  private readonly listeners = new Map<string, Set<Listener>>();
  private state: ConfigState | undefined;

  constructor(private readonly options: RuntimeOptions) {
    this.jobs = new JobRunner<DeliberationResult>({
      ...(options.now && { now: options.now }),
      newRunId: options.newRunId ?? (() => defaultRunId(new Date((options.now ?? Date.now)()))),
      onEvent: (runId, event) => {
        this.options.logger.debug({ runId, event }, "council event");
        for (const l of this.listeners.get(runId) ?? []) l(event);
      },
    });
  }

  get logger(): Logger {
    return this.options.logger;
  }

  /** Состав моделей на сессию сервера (/council-models): поверх конфига, до перезапуска. */
  private modelsOverride: string[] | undefined;

  get settings(): RuntimeOptions {
    return this.options;
  }

  setModels(ids: string[] | undefined): void {
    if (ids !== undefined) {
      const uniq = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
      if (uniq.length < 2) throw new InputError("models: нужно минимум две разные модели");
      this.modelsOverride = uniq;
    } else {
      this.modelsOverride = undefined;
    }
  }

  /** Конфиг (с переопределением состава моделей на сессию, если оно есть). */
  config(): ConfigState {
    const base = this.loadBase();
    if (!base.ok || this.modelsOverride === undefined) return base;
    const known = new Map(base.config.models.map((m) => [m.id, m]));
    const template = base.config.models[0];
    const models = this.modelsOverride.map(
      (id) =>
        known.get(id) ?? {
          ...(template ?? { context: 32_000, output: 8_000, maxConcurrency: 1 }),
          id,
        },
    );
    return { ok: true, config: { ...base.config, models } };
  }

  /** Конфиг читается при первом обращении и перечитывается, пока он с ошибкой. */
  private loadBase(): ConfigState {
    if (this.state?.ok) return this.state;
    try {
      this.state = { ok: true, config: loadConfig(this.options.configDeps()) };
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      this.state = { ok: false, error: e.message };
    }
    return this.state;
  }

  /** Запускает обсуждение в фоне; ошибки входа и бюджета бросаются сразу, до старта. */
  async start(input: DeliberateInput, config: CouncilConfig): Promise<string> {
    // Проверка входа и бюджета до создания задачи — чтобы хост получил ошибку сразу.
    const plan = await planRun(input, config, "budget-check");
    if (plan.overBudget.length > 0 && input.confirmBudget !== true) {
      throw new BudgetError(
        `прогноз превышает бюджет: ${plan.overBudget.join("; ")}. ${renderEstimate(plan.estimate)}. Спросите пользователя и повторите с confirm_budget: true или уменьшите panel/max_rounds.`,
        plan.estimate,
      );
    }
    // Агент-участник ищется до старта: «opencode не найден» — ошибка вызова, а не упавший запуск.
    const driver = this.options.makeDriver(config);
    return this.jobs.start(async ({ runId, signal, emit }) => {
      this.options.logger.info(
        { runId, mode: input.mode, driver: driver.name },
        "council run started",
      );
      try {
        const result = await deliberate(input, {
          config,
          driver,
          runId,
          emit,
          signal,
          ...(this.options.now && { now: this.options.now }),
        });
        this.options.logger.info(
          { runId, status: result.status, usage: result.usage },
          "council run finished",
        );
        return result;
      } finally {
        await driver.dispose().catch(() => undefined);
      }
    });
  }

  private machines = new Map<string, WorkflowMachine>();

  machine(config: CouncilConfig): WorkflowMachine {
    let m = this.machines.get(config.paths.stateDir);
    if (!m) {
      m = new WorkflowMachine({ config, ...(this.options.now && { now: this.options.now }) });
      this.machines.set(config.paths.stateDir, m);
    }
    return m;
  }

  /** Состояние процесса с восстановлением фазы, прерванной перезапуском сервера. */
  async workflowState(config: CouncilConfig, id?: string): Promise<WorkflowState> {
    const m = this.machine(config);
    return m.recover(await m.get(id), (runId) => this.jobs.snapshot(runId)?.status === "running");
  }

  /**
   * Прогнать текущую фазу процесса в фоне (как обычный запуск — ждать через council_wait).
   * Участники develop/deliver читают код в worktree процесса.
   */
  async startPhase(
    config: CouncilConfig,
    id: string | undefined,
    input: PhaseInput,
  ): Promise<string> {
    const machine = this.machine(config);
    const state = await this.workflowState(config, id);
    if (state.status === "running") throw new WorkflowError(`фаза ${state.phase} уже идёт`);
    if (state.status === "aborted" || state.status === "done")
      throw new WorkflowError(`процесс ${state.id}: ${state.status}`);
    // Проверка входа фазы до старта задачи (например, нет диффа для develop).
    machine.preflight(state, input);
    return this.jobs.start(async ({ runId, signal, emit }) => {
      const runner: PhaseRunner = async (deliberation, workspace) => {
        const driver = this.options.makeDriver({ ...config, workspace });
        try {
          return await deliberate(deliberation, {
            config,
            driver,
            runId,
            emit,
            signal,
            ...(this.options.now && { now: this.options.now }),
          });
        } finally {
          await driver.dispose().catch(() => undefined);
        }
      };
      const ar = await machine.advance(state.id, input, runner);
      if (!ar.result) throw new WorkflowError("фаза завершилась без запуска совета");
      const result: Omit<DeliberationResult, "report"> = {
        ...ar.result,
        workflow: {
          id: ar.state.id,
          phase: ar.phase,
          gate: ar.gate,
          next: ar.next,
          options: ar.options,
          state_path: relative(config.workspace, join(config.paths.stateDir, "STATE.md")),
          status: ar.state.status,
          current_phase: ar.state.phase,
        },
      };
      return { ...result, report: renderReport(result) };
    });
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  wait(runId: string, waitMs: number): Promise<JobSnapshot<DeliberationResult> | undefined> {
    return this.jobs.wait(runId, waitMs);
  }

  /** Итог прошлого запуска: из памяти или из транскрипта (переживает перезапуск сервера). */
  async getRun(
    runId: string,
    config: CouncilConfig,
  ): Promise<JobSnapshot<DeliberationResult> | undefined> {
    const live = this.jobs.snapshot(runId);
    if (live) return live;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return undefined;
    let text: string;
    try {
      text = await readFile(join(config.paths.stateDir, "runs", `${runId}.jsonl`), "utf8");
    } catch {
      return undefined;
    }
    const last = text.trim().split("\n").at(-1);
    try {
      const entry = JSON.parse(last ?? "") as { type?: string; result?: DeliberationResult };
      if (entry.type === "run_finished" && entry.result) {
        return { runId, status: "done", progress: "", result: entry.result };
      }
    } catch {
      // транскрипт оборван
    }
    return {
      runId,
      status: "failed",
      progress: "",
      error: "запуск не завершён: в транскрипте нет итога",
    };
  }

  async shutdown(): Promise<void> {
    await this.jobs.shutdown();
  }
}
