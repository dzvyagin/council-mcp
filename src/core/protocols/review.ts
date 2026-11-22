import { buildContext, type ContextInput } from "../context/builder.js";
import type { CouncilSession, Seat } from "../engine.js";
import { goNoGo, quorumNeeded, type Verdict } from "../gates.js";
import { newNonce } from "../prompts/common.js";
import { reviewPrompt, type DebateCommon } from "../prompts/debate.js";
import type { RunStatus } from "../types.js";
import { REVIEW_TOOLS, type Finding, type Review } from "./debate-schemas.js";

/**
 * Review: каждая персона (по умолчанию red-team) смотрит дифф и возвращает pass/fail с находками.
 * Score = доля pass; go — score ≥ порога и нет critical. Находки объединяются по месту и заголовку.
 */

export interface ReviewInput extends ContextInput {
  question: string;
  diff: string;
}

export interface ReviewFinding extends Finding {
  /** Кто нашёл (метки мест). */
  by: string[];
}

export interface ReviewOutcome {
  status: RunStatus;
  go: boolean;
  score: number;
  criticals: number;
  reviews: Map<string, Review>;
  findings: ReviewFinding[];
  roles: Map<string, string>;
  warnings: string[];
}

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 } as const;

/** Объединение одинаковых находок разных участников: файл + строка + заголовок без регистра. */
export function mergeFindings(reviews: Map<string, Review>): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding>();
  for (const [alias, review] of reviews) {
    for (const f of review.findings) {
      const key = `${f.file ?? ""}:${String(f.line ?? "")}:${f.title.trim().toLowerCase()}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...f, by: [alias] });
        continue;
      }
      prev.by.push(alias);
      if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[prev.severity]) prev.severity = f.severity;
      prev.blocker ||= f.blocker;
    }
  }
  return [...byKey.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.by.length - a.by.length,
  );
}

/** Блокеры места: явные blocker и все critical. */
export function toVerdict(alias: string, review: Review): Verdict {
  return {
    alias,
    verdict: review.verdict,
    blockers: review.findings
      .filter((f) => f.blocker || f.severity === "critical")
      .map((f) => ({ severity: f.severity, text: f.title })),
  };
}

export async function runReview(
  session: CouncilSession,
  input: ReviewInput,
  threshold: number,
): Promise<ReviewOutcome> {
  const nonce = newNonce();
  const context = buildContext(input);
  const roleOf = new Map(
    session.seats.map((s) => [s.alias, `${s.persona.name} — ${s.persona.focus}`]),
  );
  const common = (seat: Seat): DebateCommon => ({
    question: input.question,
    context,
    nonce,
    role: roleOf.get(seat.alias) ?? seat.persona.name,
  });
  const warnings: string[] = [];

  const reviews = await session.askAll("review", (seat) => ({
    role: roleOf.get(seat.alias) ?? "",
    tool: REVIEW_TOOLS.review,
    prompt: reviewPrompt(common(seat), REVIEW_TOOLS.review.name),
  }));
  const base = { reviews, roles: roleOf, warnings, findings: mergeFindings(reviews) };
  if (reviews.size === 0) return { ...base, status: "failed", go: false, score: 0, criticals: 0 };
  const needed = quorumNeeded(session.seats.length);
  if (reviews.size < needed) {
    warnings.push(
      `нет кворума: ответили ${String(reviews.size)} из ${String(session.seats.length)}, нужно ${String(needed)}`,
    );
    return { ...base, status: "quorum_failed", go: false, score: 0, criticals: 0 };
  }

  const verdicts = [...reviews.entries()].map(([alias, r]) => toVerdict(alias, r));
  const g = goNoGo(verdicts, threshold);
  const models = new Set([...reviews.keys()].map((a) => session.seat(a)?.model.id)).size;
  if (models < 2) warnings.push("ответила только одна модель: решение не проходит гейт");
  const same = verdicts.every((v) => v.verdict === verdicts[0]?.verdict);
  const status: RunStatus = models < 2 ? "partial" : same ? "converged" : "majority";
  return { ...base, status, go: g.go && models >= 2, score: g.score, criticals: g.criticals };
}
