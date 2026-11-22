import type { CouncilConfig } from "./config.js";
import { CouncilSession } from "./engine.js";
import { noopSink, type EventSink } from "./events.js";
import { dissentText, renderReport } from "./output/report.js";
import type { ParticipantDriver } from "./participant.js";
import { runVote, voteTool, type VoteInput } from "./protocols/vote.js";
import { toUsageSummary, type DeliberationResult, type Mode } from "./types.js";

export interface DeliberateInput extends VoteInput {
  mode: Mode;
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

function validate(input: DeliberateInput): void {
  if (input.question.trim().length === 0) throw new InputError("question: пустой вопрос");
  if (input.mode !== "vote") {
    throw new InputError(
      `mode: режим «${input.mode}» появится в следующих фазах; сейчас доступен vote`,
    );
  }
  if (input.options) {
    const uniq = new Set(input.options.map((o) => o.trim()));
    if (input.options.length < 2 || uniq.size !== input.options.length) {
      throw new InputError("options: нужно минимум два разных варианта");
    }
  }
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
    tools: [voteTool(input.options)],
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
    const { tally, votes } = await runVote(session, input, deps.runId);
    const warnings: string[] = [];
    let status = tally.status;
    if (signal.aborted) {
      status = "partial";
      warnings.push("запуск отменён — итог по уже полученным голосам");
    }
    if (session.activeModels < 2 && votes.length > 0) {
      warnings.push("ответила только одна модель: решение не проходит гейт");
    }
    if (status === "tie") warnings.push("голоса разделились — запустите consensus");

    const threshold = deps.config.defaults.majorityThreshold;
    const passed = (status === "converged" || status === "majority") && tally.score >= threshold;
    const result: Omit<DeliberationResult, "report"> = {
      run_id: deps.runId,
      mode: input.mode,
      status,
      decision: tally.winner ?? "",
      score: Math.round(tally.score * 100) / 100,
      gate: { threshold, passed },
      participants: session.summaries(),
      open_questions: [],
      votes,
      warnings,
      usage: toUsageSummary(session.usage, now() - started),
    };
    const dissent = status === "tie" ? undefined : dissentText(tally.dissent);
    if (dissent) result.dissent = dissent;
    emit({ type: "run_finished", status });
    return { ...result, report: renderReport(result) };
  } finally {
    await session.close();
  }
}
