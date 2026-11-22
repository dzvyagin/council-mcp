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
  const persona = p.personas.length > 0 ? ` (${p.personas.join(", ")})` : "";
  return `${markerFor(p.alias)} ${p.alias}${persona} ${mark}${note}`;
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
    `Статус: ${STATUS_TEXT[r.status] ?? r.status} · score ${r.score.toFixed(2)} (${gate}) · ${r.gate.veto ? `вето ${r.gate.veto.persona}` : "вето нет"} · кворум ${String(answered)}/${String(r.participants.length)}`,
    `Решение: ${r.decision || "—"}`,
  ];
  if (r.gate.veto) lines.push(`Вето (${r.gate.veto.persona}): ${clip(r.gate.veto.reason, 200)}`);
  if (r.dissent) lines.push(`Особое мнение: ${clip(r.dissent, 400)}`);
  if (r.debate) {
    const d = r.debate;
    lines.push(`Варианты: 1) ${clip(d.options[0], 80)} · 2) ${clip(d.options[1], 80)}`);
    if (d.criteria.length > 0) {
      lines.push(
        `Баллы: ${d.criteria.map((c) => `${c.criterion} ${c.first.toFixed(1)}/${c.second.toFixed(1)}`).join(" · ")}`,
      );
    }
    lines.push(
      `Прогоны: ${d.passes.map((p, i) => `${i === 0 ? "" : "обмен сторон "}${p.first}↔${p.second} → ${p.winner ? clip(p.winner, 40) : "ничья"} (${p.confidence.toFixed(2)})`).join(" · ")}`,
    );
  } else if (r.review) {
    const passes = r.votes?.filter((v) => v.choice === "pass").length ?? 0;
    lines.push(
      `Вердикт: ${r.review.verdict === "go" ? "GO" : "NO-GO"} · pass ${String(passes)}/${String(r.votes?.length ?? 0)} · critical ${String(r.review.criticals)}`,
    );
    for (const f of r.review.findings.slice(0, 5)) {
      const where = f.file ? ` ${f.file}${f.line ? `:${String(f.line)}` : ""}` : "";
      lines.push(`- [${f.severity}]${where} ${clip(f.title, 120)} (${f.by.join(", ")})`);
    }
    if (r.review.findings.length > 5) lines.push(`- … ещё ${String(r.review.findings.length - 5)}`);
  } else if (r.votes && r.votes.length > 0) {
    lines.push(
      `Голоса: ${r.votes.map((v) => `${v.alias} ${clip(v.choice, 60)} ${v.confidence.toFixed(2)}`).join(" · ")}`,
    );
  }
  const refs = [
    ...(r.open_questions.length > 0
      ? [`Открытые вопросы: ${String(r.open_questions.length)}`]
      : []),
    ...(r.adr_path !== undefined ? [`ADR: ${r.adr_path}`] : []),
  ];
  if (refs.length > 0) lines.push(refs.join(" · "));
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  lines.push(
    `Расход: ${r.usage.calls} ${plural(r.usage.calls, ["вызов", "вызова", "вызовов"])} · ${formatTokens(r.usage.prompt_tokens + r.usage.completion_tokens)} токенов · ${formatDuration(r.usage.duration_s * 1000)}`,
  );
  lines.push(`Транскрипт: ${r.transcript_path}`);
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
