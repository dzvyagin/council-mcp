import { relative } from "node:path";

import { PANEL_SIZES, STYLES, type PanelSize, type Style } from "./config.js";
import { estimate, loadHistory, renderEstimate, type Estimate } from "./estimate.js";
import { quorumNeeded } from "./gates.js";
import { formatTokens } from "./output/format.js";
import { buildPanel, type SeatSpec } from "./panel.js";

import type { CouncilConfig } from "./config.js";
import { DEFAULT_MAX_BYTES } from "./context/builder.js";
import { Redactor } from "./context/redact.js";
import { CouncilSession } from "./engine.js";
import { noopSink, type EventSink } from "./events.js";
import { writeAdr, type AdrData } from "./output/adr.js";
import { consensusAdr, voteAdr } from "./output/adr-data.js";
import { dissentText, renderReport } from "./output/report.js";
import { TranscriptWriter } from "./output/transcript.js";
import type { AnswerTool, ParticipantDriver } from "./participant.js";
import { consensusTools } from "./protocols/consensus-schemas.js";
import { runConsensus } from "./protocols/consensus.js";
import { runVote, voteTool } from "./protocols/vote.js";
import {
  GOALS,
  toUsageSummary,
  type DeliberationResult,
  type Goal,
  type Mode,
  type ParticipantSummary,
  type RunStatus,
  type VoteRecord,
} from "./types.js";

export interface DeliberateInput {
  mode: Mode;
  question: string;
  options?: string[];
  notes?: string;
  files?: string[];
  diff?: string;
  maxBytes?: number;
  maxRounds?: number;
  panel?: PanelSize;
  goal?: Goal;
  style?: Style;
  /** Шаг исследования перед раундами (только consensus). */
  researchFirst?: boolean;
  budget?: Budget;
  /** Запускать, даже если прогноз превышает бюджет (подтверждение человека). */
  confirmBudget?: boolean;
  /** По умолчанию ADR пишется для goal decision/plan/implement и любого итога, кроме failed. */
  writeAdr?: boolean;
  adrTitle?: string;
}

export interface Budget {
  maxCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxDurationS?: number | undefined;
}

export interface DeliberateDeps {
  config: CouncilConfig;
  driver: ParticipantDriver;
  runId: string;
  emit?: EventSink;
  signal?: AbortSignal;
  now?: () => number;
  /** false — не писать транскрипт и ADR (юнит-тесты протоколов). */
  artifacts?: boolean;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Прогноз превышает бюджет: запуск не начат, нужно подтверждение (confirm_budget). */
export class BudgetError extends Error {
  constructor(
    message: string,
    readonly estimate: Estimate,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

const SUPPORTED: Mode[] = ["vote", "consensus"];

export function validate(input: DeliberateInput): void {
  if (input.question.trim().length === 0) throw new InputError("question: пустой вопрос");
  if (!SUPPORTED.includes(input.mode)) {
    throw new InputError(
      `mode: режим «${input.mode}» появится в следующих фазах; сейчас доступны ${SUPPORTED.join(", ")}`,
    );
  }
  if (input.options) {
    const uniq = new Set(input.options.map((o) => o.trim()));
    if (input.options.length < 2 || uniq.size !== input.options.length) {
      throw new InputError("options: нужно минимум два разных варианта");
    }
  }
  if (input.maxRounds !== undefined && (input.maxRounds < 0 || input.maxRounds > 5)) {
    throw new InputError("max_rounds: от 0 до 5");
  }
  if (input.maxBytes !== undefined && input.maxBytes < 1_000) {
    throw new InputError("context.max_bytes: не меньше 1000");
  }
  if (input.panel !== undefined && !PANEL_SIZES.includes(input.panel)) {
    throw new InputError("panel: 3, 5 или 7");
  }
  if (input.goal !== undefined && !GOALS.includes(input.goal)) {
    throw new InputError(`goal: ${GOALS.join(" | ")}`);
  }
  if (input.style !== undefined && !STYLES.includes(input.style)) {
    throw new InputError(`style: ${STYLES.join(" | ")}`);
  }
  if (input.researchFirst === true && input.mode !== "consensus") {
    throw new InputError("research_first: поддерживается только в режиме consensus");
  }
}

export interface RunPlan {
  seats: SeatSpec[];
  goal: Goal;
  style: Style;
  maxRounds: number;
  estimate: Estimate;
  budget: Budget;
  /** Нарушения бюджета по прогнозу (верхней границе). */
  overBudget: string[];
}

/** Состав панели и прогноз — без вызовов моделей (council_estimate, dry_run, проверка бюджета). */
export async function planRun(
  input: DeliberateInput,
  config: CouncilConfig,
  runId: string,
): Promise<RunPlan> {
  validate(input);
  const style = input.style ?? config.defaults.style;
  const goal = input.goal ?? "decision";
  const panel = input.panel ?? config.defaults.panel;
  const maxRounds = input.maxRounds ?? config.defaults.maxRounds;
  const seats = buildPanel({
    models: config.models,
    panel,
    style,
    seed: runId,
    personas: config.personas,
  });
  const contextBytes = Buffer.byteLength(
    `${input.question}${input.notes ?? ""}${input.diff ?? ""}`,
    "utf8",
  );
  const history = await loadHistory(config.paths.stateDir);
  const est = estimate(
    {
      mode: input.mode,
      seats: seats.length,
      maxRounds,
      researchFirst: input.researchFirst === true,
      contextBytes,
    },
    history,
  );
  const budget: Budget = { ...config.defaults.budget, ...input.budget };
  const overBudget: string[] = [];
  if (budget.maxCalls !== undefined && est.calls.max > budget.maxCalls) {
    overBudget.push(`вызовов до ${String(est.calls.max)} при лимите ${String(budget.maxCalls)}`);
  }
  if (budget.maxTokens !== undefined && est.tokens.max > budget.maxTokens) {
    overBudget.push(
      `токенов до ${formatTokens(est.tokens.max)} при лимите ${formatTokens(budget.maxTokens)}`,
    );
  }
  return { seats, goal, style, maxRounds, estimate: est, budget, overBudget };
}

function toolsFor(input: DeliberateInput): AnswerTool[] {
  return input.mode === "vote" ? [voteTool(input.options)] : consensusTools();
}

type AdrBase = Parameters<typeof consensusAdr>[0];

interface ProtocolResult {
  status: RunStatus;
  decision: string;
  dissent?: string;
  score: number;
  threshold: number;
  openQuestions: string[];
  votes: VoteRecord[];
  warnings: string[];
  veto?: { persona: string; reason: string };
  adr: (base: AdrBase, summaries: ParticipantSummary[]) => AdrData;
}

async function runProtocol(
  input: DeliberateInput,
  session: CouncilSession,
  config: CouncilConfig,
  seed: string,
  plan: RunPlan,
): Promise<ProtocolResult> {
  if (input.mode === "vote") {
    const { tally, votes } = await runVote(
      session,
      {
        question: input.question,
        ...(input.options && { options: input.options }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.files && { files: input.files }),
      },
      seed,
    );
    const warnings: string[] = [];
    const needed = quorumNeeded(session.seats.length);
    const quorumFailed = votes.length > 0 && votes.length < needed;
    if (quorumFailed) {
      warnings.push(
        `нет кворума: проголосовали ${String(votes.length)} из ${String(session.seats.length)}, нужно ${String(needed)}`,
      );
    } else if (session.activeModels < 2 && votes.length > 0) {
      warnings.push("ответила только одна модель: решение не проходит гейт");
    }
    if (tally.status === "tie" && !quorumFailed)
      warnings.push("голоса разделились — запустите consensus");
    const dissent = tally.status === "tie" || quorumFailed ? undefined : dissentText(tally.dissent);
    return {
      status: quorumFailed ? "quorum_failed" : tally.status,
      decision: quorumFailed ? "" : (tally.winner ?? ""),
      ...(dissent !== undefined && { dissent }),
      score: tally.score,
      threshold: config.defaults.majorityThreshold,
      openQuestions: [],
      votes,
      warnings,
      adr: (base, summaries) => voteAdr(base, tally, votes, input.options, dissent, summaries),
    };
  }

  const outcome = await runConsensus(
    session,
    {
      question: input.question,
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.files && { files: input.files }),
      ...(input.diff !== undefined && { diff: input.diff }),
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      ...(input.researchFirst === true && { researchFirst: true }),
    },
    {
      seed,
      maxRounds: plan.maxRounds,
      majorityThreshold: config.defaults.majorityThreshold,
      ...(config.chair !== undefined && { chairModelId: config.chair }),
      goal: plan.goal,
      style: plan.style,
    },
  );
  const warnings = [...outcome.warnings];
  if (outcome.status === "no_consensus")
    warnings.push("консенсус не достигнут — решение за человеком");
  if (outcome.veto) {
    warnings.push(`вето ${outcome.veto.persona} (${outcome.veto.critic}): ${outcome.veto.text}`);
  }
  const votes: VoteRecord[] = outcome.positions.map((p) => ({
    alias: p.alias,
    choice: p.key,
    confidence: p.confidence,
    rationale: outcome.finals.get(p.alias)?.summary ?? "",
  }));
  const dissent = outcome.synthesis?.dissent;
  return {
    status: outcome.status,
    decision: outcome.decision,
    ...(dissent !== undefined && { dissent }),
    score: outcome.score,
    threshold: config.defaults.qualityThreshold,
    ...(outcome.veto && { veto: { persona: outcome.veto.persona, reason: outcome.veto.text } }),
    openQuestions: outcome.synthesis?.open_questions ?? [],
    votes,
    warnings,
    adr: (base, summaries) => consensusAdr(base, outcome, summaries),
  };
}

/** Маскирует секреты во входе: он уходит в промпты всех участников. */
function redactInput(input: DeliberateInput, redactor: Redactor): DeliberateInput {
  return {
    ...input,
    question: redactor.text(input.question),
    ...(input.options && { options: input.options.map((o) => redactor.text(o)) }),
    ...(input.notes !== undefined && { notes: redactor.text(input.notes) }),
    ...(input.diff !== undefined && { diff: redactor.text(input.diff) }),
  };
}

const ADR_TITLE_MAX = 100;

/** Публичная точка входа ядра: одно обсуждение. */
export async function deliberate(
  input: DeliberateInput,
  deps: DeliberateDeps,
): Promise<DeliberationResult> {
  const { config } = deps;
  const plan = await planRun(input, config, deps.runId);
  if (plan.overBudget.length > 0 && input.confirmBudget !== true) {
    throw new BudgetError(
      `прогноз превышает бюджет: ${plan.overBudget.join("; ")}. ${renderEstimate(plan.estimate)}. Подтвердите запуск (confirm_budget) или уменьшите panel/max_rounds.`,
      plan.estimate,
    );
  }
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? noopSink;
  const signal = deps.signal ?? new AbortController().signal;
  const artifacts = deps.artifacts ?? true;
  const redactor = new Redactor([config.endpoint.apiKey.reveal()]);
  const safeInput = redactInput(input, redactor);
  const started = now();
  const rel = (path: string) => relative(config.workspace, path);

  const transcript = new TranscriptWriter(config.paths.stateDir, deps.runId, redactor, now);
  const session = new CouncilSession({
    driver: deps.driver,
    seats: plan.seats,
    tools: toolsFor(safeInput),
    seed: deps.runId,
    roundTimeoutS: config.participant.roundTimeoutS,
    emit,
    signal,
    ...(artifacts && {
      record: (entry) => {
        transcript.write(entry);
      },
    }),
  });
  emit({
    type: "run_started",
    runId: deps.runId,
    mode: input.mode,
    aliases: session.seats.map((s) => s.alias),
  });
  if (artifacts) {
    transcript.write({
      type: "run_started",
      mode: input.mode,
      input: safeInput,
      seats: session.assignments,
      goal: plan.goal,
      style: plan.style,
      estimate: plan.estimate,
      driver: deps.driver.name,
    });
  }

  try {
    const p = await runProtocol(safeInput, session, config, deps.runId, plan);
    let status = p.status;
    const warnings = [...p.warnings];
    if (signal.aborted) {
      status = "partial";
      warnings.unshift("запуск отменён — итог по уже полученным ответам");
    }
    const passed =
      (status === "converged" || status === "majority") &&
      p.score >= p.threshold &&
      p.veto === undefined;
    const score = Math.round(p.score * 100) / 100;
    const gate = { threshold: p.threshold, passed, ...(p.veto && { veto: p.veto }) };
    const summaries = session.summaries();

    let adrPath: string | undefined;
    const adrByGoal = plan.goal === "decision" || plan.goal === "plan" || plan.goal === "implement";
    const wantAdr = input.writeAdr ?? adrByGoal;
    if (artifacts && wantAdr && status !== "failed" && p.decision.trim() !== "") {
      try {
        const title = (input.adrTitle ?? safeInput.question)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, ADR_TITLE_MAX);
        const data = p.adr(
          {
            title,
            date: new Date(now()).toISOString().slice(0, 10),
            runId: deps.runId,
            mode: input.mode,
            transcript: rel(transcript.path),
            status,
            score,
            gate,
            question: safeInput.question,
            ...(safeInput.notes !== undefined && { notes: safeInput.notes }),
            warnings,
          },
          summaries,
        );
        adrPath = rel((await writeAdr(config.paths.adrDir, redactor.deep(data))).path);
      } catch (e) {
        warnings.push(`ADR не записан: ${(e as Error).message}`);
      }
    }

    const result: Omit<DeliberationResult, "report"> = redactor.deep({
      run_id: deps.runId,
      mode: input.mode,
      status,
      decision: p.decision,
      ...(p.dissent !== undefined && { dissent: p.dissent }),
      score,
      gate,
      participants: summaries,
      open_questions: p.openQuestions,
      votes: p.votes,
      warnings,
      ...(adrPath !== undefined && { adr_path: adrPath }),
      transcript_path: rel(transcript.path),
      usage: toUsageSummary(session.usage, now() - started),
    });
    emit({ type: "run_finished", status });
    if (artifacts) {
      transcript.write({
        type: "run_finished",
        status,
        score,
        gate,
        adr_path: adrPath,
        usage: result.usage,
        result: { ...result, report: renderReport(result) },
      });
      const failure = await transcript.flush();
      if (failure) result.warnings.push(`транскрипт записан не полностью: ${failure.message}`);
    }
    return { ...result, report: renderReport(result) };
  } finally {
    await session.close();
  }
}
