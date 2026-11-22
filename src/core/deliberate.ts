import type { CouncilConfig } from "./config.js";
import { DEFAULT_MAX_BYTES } from "./context/builder.js";
import { CouncilSession } from "./engine.js";
import { noopSink, type EventSink } from "./events.js";
import { dissentText, renderReport } from "./output/report.js";
import type { AnswerTool, ParticipantDriver } from "./participant.js";
import { consensusTools } from "./protocols/consensus-schemas.js";
import { runConsensus } from "./protocols/consensus.js";
import { runVote, voteTool } from "./protocols/vote.js";
import {
  toUsageSummary,
  type DeliberationResult,
  type Mode,
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
}

export interface DeliberateDeps {
  config: CouncilConfig;
  driver: ParticipantDriver;
  runId: string;
  emit?: EventSink;
  signal?: AbortSignal;
  now?: () => number;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const SUPPORTED: Mode[] = ["vote", "consensus"];

function validate(input: DeliberateInput): void {
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
}

function toolsFor(input: DeliberateInput): AnswerTool[] {
  return input.mode === "vote" ? [voteTool(input.options)] : consensusTools();
}

interface ProtocolResult {
  status: RunStatus;
  decision: string;
  dissent?: string;
  score: number;
  threshold: number;
  openQuestions: string[];
  votes: VoteRecord[];
  warnings: string[];
}

async function runProtocol(
  input: DeliberateInput,
  session: CouncilSession,
  config: CouncilConfig,
  seed: string,
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
    if (session.activeModels < 2 && votes.length > 0) {
      warnings.push("ответила только одна модель: решение не проходит гейт");
    }
    if (tally.status === "tie") warnings.push("голоса разделились — запустите consensus");
    const dissent = tally.status === "tie" ? undefined : dissentText(tally.dissent);
    return {
      status: tally.status,
      decision: tally.winner ?? "",
      ...(dissent !== undefined && { dissent }),
      score: tally.score,
      threshold: config.defaults.majorityThreshold,
      openQuestions: [],
      votes,
      warnings,
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
    },
    {
      seed,
      maxRounds: input.maxRounds ?? config.defaults.maxRounds,
      majorityThreshold: config.defaults.majorityThreshold,
      ...(config.chair !== undefined && { chairModelId: config.chair }),
    },
  );
  const warnings = [...outcome.warnings];
  if (outcome.status === "no_consensus")
    warnings.push("консенсус не достигнут — решение за человеком");
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
    score: outcome.convergence?.score ?? 0,
    threshold: config.defaults.qualityThreshold,
    openQuestions: outcome.synthesis?.open_questions ?? [],
    votes,
    warnings,
  };
}

/** Публичная точка входа ядра: одно обсуждение. */
export async function deliberate(
  input: DeliberateInput,
  deps: DeliberateDeps,
): Promise<DeliberationResult> {
  validate(input);
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? noopSink;
  const signal = deps.signal ?? new AbortController().signal;
  const started = now();

  const session = new CouncilSession({
    driver: deps.driver,
    models: deps.config.models,
    tools: toolsFor(input),
    seed: deps.runId,
    roundTimeoutS: deps.config.participant.roundTimeoutS,
    emit,
    signal,
  });
  emit({
    type: "run_started",
    runId: deps.runId,
    mode: input.mode,
    aliases: session.seats.map((s) => s.alias),
  });

  try {
    const p = await runProtocol(input, session, deps.config, deps.runId);
    let status = p.status;
    const warnings = [...p.warnings];
    if (signal.aborted) {
      status = "partial";
      warnings.unshift("запуск отменён — итог по уже полученным ответам");
    }
    const passed = (status === "converged" || status === "majority") && p.score >= p.threshold;
    const result: Omit<DeliberationResult, "report"> = {
      run_id: deps.runId,
      mode: input.mode,
      status,
      decision: p.decision,
      ...(p.dissent !== undefined && { dissent: p.dissent }),
      score: Math.round(p.score * 100) / 100,
      gate: { threshold: p.threshold, passed },
      participants: session.summaries(),
      open_questions: p.openQuestions,
      votes: p.votes,
      warnings,
      usage: toUsageSummary(session.usage, now() - started),
    };
    emit({ type: "run_finished", status });
    return { ...result, report: renderReport(result) };
  } finally {
    await session.close();
  }
}
