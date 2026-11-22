import type { Usage } from "./participant.js";

export type RunStatus =
  | "converged"
  | "majority"
  | "no_consensus"
  | "vetoed"
  | "quorum_failed"
  | "tie"
  | "partial"
  | "failed";

export type Mode = "consensus" | "debate" | "vote" | "review";

export type SeatState = "ok" | "degraded" | "failed";

export interface ParticipantSummary {
  alias: string;
  personas: string[];
  state: SeatState;
  /** Причина деградации или отказа (без имён моделей). */
  note?: string;
}

export interface VoteRecord {
  alias: string;
  choice: string;
  confidence: number;
  rationale: string;
}

export interface UsageSummary {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  duration_s: number;
}

/** Итог запуска — то, что видит хост-агент. Имён моделей здесь нет. */
export interface DeliberationResult {
  run_id: string;
  mode: Mode;
  status: RunStatus;
  report: string;
  decision: string;
  dissent?: string;
  score: number;
  gate: { threshold: number; passed: boolean };
  participants: ParticipantSummary[];
  open_questions: string[];
  votes?: VoteRecord[];
  warnings: string[];
  /** Пути относительно COUNCIL_WORKSPACE. */
  adr_path?: string;
  transcript_path: string;
  usage: UsageSummary;
}

/** Внутренняя связка «метка → модель»: только для транскрипта, наружу не уходит. */
export interface SeatAssignment {
  alias: string;
  modelId: string;
}

export const toUsageSummary = (u: Usage, durationMs: number): UsageSummary => ({
  calls: u.calls,
  prompt_tokens: u.inputTokens,
  completion_tokens: u.outputTokens,
  duration_s: Math.round(durationMs / 1000),
});
