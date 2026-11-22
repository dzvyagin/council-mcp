import type { DeliberationResult, ParticipantSummary } from "../types.js";
import { formatDuration, formatTokens, markerFor, plural } from "./format.js";

/** Единый отчёт по запуску (до ~2 КБ) — его хост показывает пользователю без пересказа. */

const STATUS_TEXT: Record<string, string> = {
  converged: "converged",
  majority: "majority",
  no_consensus: "no_consensus",
  vetoed: "vetoed",
  quorum_failed: "quorum_failed",
  tie: "tie",
  partial: "partial",
  failed: "failed",
};

const MAX_RATIONALE = 160;

function seat(p: ParticipantSummary): string {
  const mark = p.state === "ok" ? "✓" : p.state === "degraded" ? "⚠ деградация" : "✗ отказ";
  const note = p.state !== "ok" && p.note ? ` (${p.note})` : "";
  return `${markerFor(p.alias)} ${p.alias} ${mark}${note}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function renderReport(r: Omit<DeliberationResult, "report">): string {
  const answered = r.votes?.length ?? r.participants.filter((p) => p.state !== "failed").length;
  const gate = `гейт ${r.gate.threshold.toFixed(2)} ${r.gate.passed ? "✓" : "✗"}`;
  const lines = [
    `🏛 Council · ${r.mode} · участников ${r.participants.length}    run ${r.run_id}`,
    `Участники: ${r.participants.map(seat).join("   ")}`,
    `Статус: ${STATUS_TEXT[r.status] ?? r.status} · score ${r.score.toFixed(2)} (${gate}) · ответили ${answered}/${r.participants.length}`,
    `Решение: ${r.decision || "—"}`,
  ];
  if (r.dissent) lines.push(`Особое мнение: ${r.dissent}`);
  if (r.votes && r.votes.length > 0) {
    lines.push(
      `Голоса: ${r.votes.map((v) => `${v.alias} ${clip(v.choice, 60)} ${v.confidence.toFixed(2)}`).join(" · ")}`,
    );
  }
  if (r.open_questions.length > 0) lines.push(`Открытые вопросы: ${r.open_questions.length}`);
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  lines.push(
    `Расход: ${r.usage.calls} ${plural(r.usage.calls, ["вызов", "вызова", "вызовов"])} · ${formatTokens(r.usage.prompt_tokens + r.usage.completion_tokens)} токенов · ${formatDuration(r.usage.duration_s * 1000)}`,
  );
  return lines.join("\n");
}

export function dissentText(
  votes: { alias: string; choice: string; rationale: string }[],
): string | undefined {
  if (votes.length === 0) return undefined;
  return votes
    .map((v) => `${v.alias}: ${clip(v.choice, 60)} — ${clip(v.rationale, MAX_RATIONALE)}`)
    .join("; ");
}
