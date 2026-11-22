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

export type Mode = "consensus" | "debate" | "vote" | "review" | "discover";

export const GOALS = ["advice", "decision", "plan", "implement", "review"] as const;
export type Goal = (typeof GOALS)[number];

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
  gate: { threshold: number; passed: boolean; veto?: { persona: string; reason: string } };
  participants: ParticipantSummary[];
  open_questions: string[];
  votes?: VoteRecord[];
  warnings: string[];
  /** review: вердикт go/no-go и находки. */
  review?: {
    verdict: "go" | "no-go";
    score: number;
    criticals: number;
    findings: {
      severity: "critical" | "major" | "minor";
      title: string;
      file?: string | undefined;
      line?: number | undefined;
      detail: string;
      blocker: boolean;
      by: string[];
    }[];
  };
  /** debate: варианты, баллы по критериям, прогоны. */
  debate?: {
    options: [string, string];
    winner?: string;
    criteria: { criterion: string; first: number; second: number }[];
    passes: { first: string; second: string; winner?: string; confidence: number }[];
  };
  /** discover: находки, варианты, ограничения и неизвестные. */
  discover?: {
    findings: { fact: string; source: string; by: string[] }[];
    options: { key: string; summary: string; by: string[] }[];
    constraints: string[];
    unknowns: string[];
  };
  /** Запуск — фаза Double Diamond: итог гейта и следующий шаг. */
  workflow?: {
    id: string;
    phase: string;
    gate: { passed: boolean; reason: string };
    next: "await_user" | "continue" | "gate_failed" | "done";
    options: string[];
    state_path: string;
    status: string;
    current_phase: string;
  };
  /** Пути относительно COUNCIL_WORKSPACE. */
  adr_path?: string;
  /** handoff plan-only: PLAN.md и git worktree с веткой council/<run_id>. */
  plan_path?: string;
  worktree_path?: string;
  branch?: string;
  transcript_path: string;
  usage: UsageSummary;
}

/** Внутренняя связка «метка → модель»: только для транскрипта, наружу не уходит. */
export interface SeatAssignment {
  alias: string;
  modelId: string;
  persona: string;
}

export const toUsageSummary = (u: Usage, durationMs: number): UsageSummary => ({
  calls: u.calls,
  prompt_tokens: u.inputTokens,
  completion_tokens: u.outputTokens,
  duration_s: Math.round(durationMs / 1000),
});
