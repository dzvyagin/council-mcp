import { join } from "node:path";

import type { CouncilConfig } from "../config.js";
import { InputError, type DeliberateInput } from "../deliberate.js";
import type { DeliberationResult } from "../types.js";
import {
  PHASES,
  phaseIndex,
  WorkflowStore,
  type Autonomy,
  type Phase,
  type PhaseRecord,
  type WorkflowState,
} from "./state.js";

/**
 * Double Diamond: discover → define → develop → deliver. `advance` прогоняет совет текущей фазы,
 * проверяет её гейт и переводит в следующую; провал гейта останавливает процесс с причиной и
 * вариантами (retry, back, принять вручную через override_reason). Код в develop пишет хост-агент
 * в worktree по PLAN.md — совет только проверяет дифф.
 *
 * Гейты: discover — кворум исследований; define — consensus score ≥ порога и нет вето;
 * develop — доля pass в ревью диффа ≥ порога; deliver — red-team go/no-go (go и нет critical).
 */

export interface PhaseInput {
  files?: string[];
  notes?: string;
  diff?: string;
}

/** Запуск совета для фазы. workspace — где участники читают код (worktree для develop/deliver). */
export type PhaseRunner = (
  input: DeliberateInput,
  workspace: string,
) => Promise<DeliberationResult>;

export type Next = "await_user" | "continue" | "gate_failed" | "done";

export interface AdvanceResult {
  state: WorkflowState;
  phase: Phase;
  result?: DeliberationResult;
  gate: { passed: boolean; reason: string };
  next: Next;
  /** Что предложить пользователю при провале гейта. */
  options: string[];
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface MachineOptions {
  config: CouncilConfig;
  now?: () => number;
  newId?: () => string;
}

const emptyPhases = (): Record<Phase, PhaseRecord> => ({
  discover: { status: "pending" },
  define: { status: "pending" },
  develop: { status: "pending" },
  deliver: { status: "pending" },
});

export class WorkflowMachine {
  readonly store: WorkflowStore;
  private readonly now: () => number;

  constructor(private readonly options: MachineOptions) {
    this.store = new WorkflowStore(options.config.paths.stateDir);
    this.now = options.now ?? Date.now;
  }

  private ts(): string {
    return new Date(this.now()).toISOString();
  }

  private note(state: WorkflowState, phase: string, event: string, note?: string): void {
    state.history.push({ ts: this.ts(), phase, event, ...(note !== undefined && { note }) });
    state.updated = this.ts();
  }

  async start(task: string, autonomy: Autonomy, input: PhaseInput = {}): Promise<WorkflowState> {
    if (task.trim() === "") throw new InputError("task: пустая задача");
    const id =
      this.options.newId?.() ??
      `wf-${new Date(this.now()).toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random().toString(16).slice(2, 8)}`;
    const state: WorkflowState = {
      id,
      task,
      autonomy,
      created: this.ts(),
      updated: this.ts(),
      phase: "discover",
      status: "ready",
      phases: emptyPhases(),
      context: {
        ...(input.files && { files: input.files }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
      history: [],
    };
    this.note(state, "discover", "start", `autonomy ${autonomy}`);
    await this.store.save(state);
    return state;
  }

  async get(id?: string): Promise<WorkflowState> {
    const state = id !== undefined ? await this.store.load(id) : await this.store.active();
    if (!state)
      throw new WorkflowError(
        id !== undefined
          ? `процесс ${id} не найден`
          : "активного процесса нет — начните с action start",
      );
    return state;
  }

  /** Фаза, которая «зависла» в running (сервер перезапускался), снова готова к запуску. */
  async recover(state: WorkflowState, isLive: (runId: string) => boolean): Promise<WorkflowState> {
    if (state.status !== "running" || state.phase === "done") return state;
    const rec = state.phases[state.phase];
    if (rec.run_id !== undefined && isLive(rec.run_id)) return state;
    rec.status = "pending";
    state.status = "ready";
    this.note(
      state,
      state.phase,
      "interrupted",
      "запуск фазы прервался (перезапуск сервера) — повторите advance",
    );
    await this.store.save(state);
    return state;
  }

  async abort(id?: string): Promise<WorkflowState> {
    const state = await this.get(id);
    state.status = "aborted";
    this.note(state, state.phase, "abort");
    await this.store.save(state);
    return state;
  }

  async back(id?: string): Promise<WorkflowState> {
    const state = await this.get(id);
    this.assertIdle(state);
    const i = phaseIndex(state.phase);
    if (i === 0) throw new WorkflowError("discover — первая фаза, назад некуда");
    const prev = PHASES[i - 1] as Phase;
    state.phase = prev;
    state.status = "ready";
    state.phases[prev] = { status: "pending" };
    this.note(state, prev, "back");
    await this.store.save(state);
    return state;
  }

  /**
   * Прогнать текущую фазу (advance или retry). С override_reason при провале гейта — принять
   * решение вручную и перейти дальше без нового запуска совета.
   */
  async advance(
    id: string | undefined,
    input: PhaseInput,
    runner: PhaseRunner,
    opts: {
      overrideReason?: string;
      onStart?: (state: WorkflowState) => void;
      /** run_id запуска фазы: пока он жив, recover не считает фазу прерванной. */
      runId?: string;
    } = {},
  ): Promise<AdvanceResult> {
    const state = await this.get(id);
    if (state.status === "aborted") throw new WorkflowError("процесс прерван");
    if (state.phase === "done") throw new WorkflowError("процесс уже завершён");
    this.assertIdle(state);
    const phase = state.phase;

    if (opts.overrideReason !== undefined) {
      if (state.status !== "gate_failed")
        throw new WorkflowError("override_reason — только после провала гейта");
      state.phases[phase] = {
        ...state.phases[phase],
        status: "overridden",
        override_reason: opts.overrideReason,
        updated: this.ts(),
      };
      this.note(state, phase, "override", opts.overrideReason);
      this.moveNext(state, phase);
      await this.store.save(state);
      return {
        state,
        phase,
        gate: { passed: true, reason: `принято вручную: ${opts.overrideReason}` },
        next: this.nextStep(state, true),
        options: [],
      };
    }

    const deliberation = this.phaseInput(state, phase, input);
    state.status = "running";
    state.phases[phase] = {
      status: "running",
      updated: this.ts(),
      ...(opts.runId !== undefined && { run_id: opts.runId }),
    };
    this.note(state, phase, "run");
    await this.store.save(state);
    opts.onStart?.(state);

    let result: DeliberationResult;
    try {
      result = await runner(deliberation, this.workspaceFor(state, phase));
    } catch (e) {
      state.status = "gate_failed";
      state.phases[phase] = {
        status: "failed",
        gate: { passed: false, reason: (e as Error).message },
        updated: this.ts(),
      };
      this.note(state, phase, "error", (e as Error).message);
      await this.store.save(state);
      throw e;
    }

    const gate = this.gate(phase, result);
    const rec: PhaseRecord = {
      status: gate.passed ? "passed" : "failed",
      run_id: result.run_id,
      gate: { ...gate, score: result.score },
      summary: result.decision,
      updated: this.ts(),
      ...(result.adr_path !== undefined && { adr_path: result.adr_path }),
      ...(result.plan_path !== undefined && { plan_path: result.plan_path }),
      ...(result.worktree_path !== undefined && { worktree_path: result.worktree_path }),
      ...(result.branch !== undefined && { branch: result.branch }),
    };
    state.phases[phase] = rec;
    if (phase === "discover" && result.discover) state.research = researchSummary(result);
    this.note(state, phase, gate.passed ? "gate passed" : "gate failed", gate.reason);
    if (gate.passed) this.moveNext(state, phase);
    else state.status = "gate_failed";
    await this.store.save(state);

    return {
      state,
      phase,
      result,
      gate,
      next: this.nextStep(state, gate.passed),
      options: gate.passed
        ? []
        : [
            "retry — повторить фазу (можно с новыми phase_input)",
            ...(phaseIndex(phase) > 0 ? ["back — вернуться на шаг назад"] : []),
            "advance с override_reason — принять решение вручную и продолжить",
            "abort — прервать процесс",
          ],
    };
  }

  /** Проверить вход фазы, ничего не меняя (ошибки — до старта фоновой задачи). */
  preflight(state: WorkflowState, input: PhaseInput): void {
    if (state.phase === "done") throw new WorkflowError("процесс уже завершён");
    this.phaseInput(state, state.phase, input);
  }

  private assertIdle(state: WorkflowState): void {
    if (state.status === "running")
      throw new WorkflowError(
        `фаза ${state.phase} уже идёт (run ${state.phase === "done" ? "" : (state.phases[state.phase].run_id ?? "?")})`,
      );
  }

  private moveNext(state: WorkflowState, phase: Phase): void {
    const next = PHASES[phaseIndex(phase) + 1];
    state.phase = next ?? "done";
    state.status = next ? "ready" : "done";
  }

  private nextStep(state: WorkflowState, passed: boolean): Next {
    if (!passed) return "gate_failed";
    if (state.phase === "done") return "done";
    // supervised — подтверждение каждой фазы; semi и auto — дальше без остановки при успехе.
    return state.autonomy === "supervised" ? "await_user" : "continue";
  }

  private worktree(state: WorkflowState): string | undefined {
    return state.phases.define.worktree_path;
  }

  private workspaceFor(state: WorkflowState, phase: Phase): string {
    const wt = this.worktree(state);
    return (phase === "develop" || phase === "deliver") && wt !== undefined
      ? join(this.options.config.workspace, wt)
      : this.options.config.workspace;
  }

  private phaseInput(state: WorkflowState, phase: Phase, input: PhaseInput): DeliberateInput {
    const files = input.files ?? state.context.files;
    const notes = [
      state.context.notes,
      input.notes,
      state.research ? `Итог исследования (discover):\n${state.research}` : undefined,
    ]
      .filter((n): n is string => n !== undefined && n.trim() !== "")
      .join("\n\n");
    const base = {
      ...(files && { files }),
      ...(notes !== "" && { notes }),
      workflowId: state.id,
    };
    switch (phase) {
      case "discover":
        return { ...base, mode: "discover", question: state.task };
      case "define":
        return {
          ...base,
          mode: "consensus",
          question: state.task,
          goal: "implement",
          handoff: "plan-only",
          adrTitle: state.task.slice(0, 100),
        };
      case "develop":
      case "deliver": {
        if (input.diff === undefined || input.diff.trim() === "") {
          throw new InputError(
            `phase_input.diff: для ${phase} нужен дифф изменений в worktree (git diff ${state.phases.define.branch ? `относительно основной ветки в ${state.phases.define.worktree_path ?? "worktree"}` : ""})`.trim(),
          );
        }
        const plan = state.phases.define.plan_path
          ? `План: ${state.phases.define.plan_path}`
          : undefined;
        return {
          ...base,
          ...(plan && { notes: [notes, plan].filter(Boolean).join("\n\n") }),
          mode: "review",
          question:
            phase === "develop"
              ? `Ревью реализации плана: ${state.task}`
              : `Финальная проверка перед выкаткой: ${state.task}`,
          diff: input.diff,
          style: phase === "develop" ? "implementation" : "red-team",
        };
      }
    }
  }

  private gate(phase: Phase, r: DeliberationResult): { passed: boolean; reason: string } {
    const t = r.gate.threshold.toFixed(2);
    switch (phase) {
      case "discover":
        return r.gate.passed
          ? {
              passed: true,
              reason: `кворум: исследование вернули ${String(r.votes?.length ?? 0)} из ${String(r.participants.length)}`,
            }
          : { passed: false, reason: `нет кворума исследований (${r.status})` };
      case "define":
        if (r.gate.veto)
          return { passed: false, reason: `вето ${r.gate.veto.persona}: ${r.gate.veto.reason}` };
        if (!r.gate.passed)
          return { passed: false, reason: `${r.status}, score ${r.score.toFixed(2)} < ${t}` };
        return {
          passed: true,
          reason: `${r.status}, score ${r.score.toFixed(2)} ≥ ${t}${r.worktree_path ? `; план в ${r.plan_path ?? "PLAN.md"}` : ""}`,
        };
      case "develop": {
        const share = r.review?.score ?? 0;
        return share >= r.gate.threshold && r.status !== "quorum_failed" && r.status !== "failed"
          ? { passed: true, reason: `доля pass ${share.toFixed(2)} ≥ ${t}` }
          : { passed: false, reason: `доля pass ${share.toFixed(2)} < ${t} (${r.status})` };
      }
      case "deliver":
        return r.review?.verdict === "go"
          ? { passed: true, reason: `GO, critical ${String(r.review.criticals)}` }
          : { passed: false, reason: `NO-GO: ${r.decision.replace(/^NO-GO:\s*/, "") || r.status}` };
    }
  }
}

function researchSummary(r: DeliberationResult): string {
  const d = r.discover;
  if (!d) return r.decision;
  return [
    ...d.findings.slice(0, 15).map((f) => `- ${f.fact} (${f.source})`),
    ...(d.options.length > 0
      ? ["Варианты:", ...d.options.map((o) => `- ${o.key}: ${o.summary}`)]
      : []),
    ...(d.constraints.length > 0
      ? ["Ограничения:", ...d.constraints.slice(0, 10).map((c) => `- ${c}`)]
      : []),
    ...(d.unknowns.length > 0
      ? ["Неизвестно:", ...d.unknowns.slice(0, 10).map((u) => `- ${u}`)]
      : []),
  ].join("\n");
}
