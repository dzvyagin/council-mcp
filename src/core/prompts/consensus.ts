import type { Critique, Proposal, Revision } from "../protocols/consensus-schemas.js";
import { buildPrompt, type DataBlock } from "./common.js";

/** Промпты раундов consensus. Чужие ответы — всегда недоверенные данные под анонимными метками. */

const MAX_DESIGN = 6_000;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}\n…(обрезано)`);

export function renderProposal(label: string, p: Proposal | Revision): string {
  const lines = [
    `### Предложение ${label}`,
    `decision_key: ${p.decision_key}`,
    `Уверенность: ${p.confidence.toFixed(2)}`,
    `Суть: ${p.summary}`,
    "",
    clip(p.design, MAX_DESIGN),
  ];
  if (p.alternatives.length > 0) {
    lines.push(
      "",
      "Отвергнутые варианты:",
      ...p.alternatives.map((a) => `- ${a.key}: ${a.summary} — ${a.why_not}`),
    );
  }
  if (p.risks.length > 0) {
    lines.push(
      "",
      "Риски:",
      ...p.risks.map(
        (r) => `- [${r.severity}] ${r.risk}${r.mitigation ? ` → ${r.mitigation}` : ""}`,
      ),
    );
  }
  if (p.assumptions.length > 0) lines.push("", "Допущения:", ...p.assumptions.map((a) => `- ${a}`));
  if (p.open_questions.length > 0)
    lines.push("", "Открытые вопросы:", ...p.open_questions.map((q) => `- ${q}`));
  if ("changes" in p && p.changes.length > 0) {
    lines.push(
      "",
      "Изменения после критики:",
      ...p.changes.map((c) => `- ${c.what} (${c.why}; аргумент ${c.triggered_by})`),
    );
  }
  return lines.join("\n");
}

export interface Common {
  question: string;
  context: DataBlock[];
  role?: string;
  nonce: string;
}

const withRole = (c: Common) => (c.role !== undefined ? { role: c.role } : {});

export function proposePrompt(c: Common, toolName: string): string {
  return buildPrompt({
    ...withRole(c),
    task: [
      "Предложи решение по вопросу из блока QUESTION. Сначала изучи проект: схему данных, миграции, контракты, существующие ADR и код, которых касается вопрос.",
      "Ответ должен быть самостоятельным: другие участники увидят его без твоих пояснений.",
      "decision_key — короткий kebab-case ключ варианта; summary — суть в 1–3 предложениях; design — решение в markdown со ссылками path:line.",
      "Укажи отвергнутые альтернативы, риски с серьёзностью (critical — делает решение неприемлемым; major — существенно; minor — мелочь), допущения и открытые вопросы.",
    ].join("\n"),
    data: [{ name: "question", content: c.question }, ...c.context],
    toolName,
    nonce: c.nonce,
  });
}

export function critiquePrompt(
  c: Common,
  others: { label: string; proposal: Proposal | Revision }[],
  toolName: string,
): string {
  const labels = others.map((o) => o.label).join(", ");
  return buildPrompt({
    ...withRole(c),
    task: [
      `Разбери предложения других участников (метки ${labels}) из блока PROPOSALS по вопросу из блока QUESTION. Проверяй утверждения по коду проекта.`,
      "Для каждого предложения: сильные стороны, недостатки с серьёзностью и вопросы. Найди минимум один существенный недостаток или явно объясни, почему его нет.",
      "critical ставь только тому, что делает решение неприемлемым (потеря данных, нарушение требований регулятора, неработоспособность).",
      `reviews — ровно по одному на каждую метку (${labels}); ranking — все эти метки от лучшего к худшему.`,
    ].join("\n"),
    data: [
      { name: "question", content: c.question },
      ...c.context,
      {
        name: "proposals",
        content: others.map((o) => renderProposal(o.label, o.proposal)).join("\n\n"),
      },
    ],
    toolName,
    nonce: c.nonce,
  });
}

export function revisePrompt(
  c: Common,
  own: Proposal | Revision,
  feedback: { critic: string; review: Critique["reviews"][number] }[],
  rating: string,
  toolName: string,
): string {
  const critiques = feedback
    .map(({ critic, review }) =>
      [
        `### Критика от ${critic}`,
        ...review.strengths.map((s) => `+ ${s}`),
        ...review.flaws.map((f) => `- [${f.severity}] ${f.text}`),
        ...review.questions.map((q) => `? ${q}`),
      ].join("\n"),
    )
    .join("\n\n");
  return buildPrompt({
    ...withRole(c),
    task: [
      "Доработай своё предложение (блок OWN) с учётом критики (блок CRITIQUES). Ты видишь только критику своего предложения.",
      `Сводный рейтинг твоего предложения: ${rating}.`,
      "Менять позицию (decision_key) можно только если конкретный аргумент тебя убедил: тогда в changes укажи, что изменилось, почему и triggered_by — метку критика. Согласие без аргумента — нарушение.",
      "Если остаёшься при своём, ответь по существу на каждый critical-недостаток в design или changes.",
      "Верни полное предложение (не только изменения).",
    ].join("\n"),
    data: [
      { name: "question", content: c.question },
      ...c.context,
      { name: "own", content: renderProposal("(твоё)", own) },
      { name: "critiques", content: critiques || "Критики нет." },
    ],
    toolName,
    nonce: c.nonce,
  });
}

export function synthesizePrompt(
  c: Common,
  finals: { label: string; proposal: Proposal | Revision }[],
  verdict: string,
  toolName: string,
): string {
  return buildPrompt({
    ...withRole(c),
    task: [
      "Ты — председатель совета. Сведи итог по финальным предложениям участников (блок PROPOSALS).",
      `Итог проверки сходимости: ${verdict}`,
      "Не добавляй идей, которых не было у участников. decision_key итога — ключ большинства, если оно есть.",
      "rationale — почему выбрано это решение, со ссылками на аргументы участников по меткам. rejected_options — отвергнутые варианты с причинами.",
      "Если решение не единогласно, dissent обязателен: позиция меньшинства, её аргументы и метки.",
    ].join("\n"),
    data: [
      { name: "question", content: c.question },
      ...c.context,
      {
        name: "proposals",
        content: finals.map((f) => renderProposal(f.label, f.proposal)).join("\n\n"),
      },
    ],
    toolName,
    nonce: c.nonce,
  });
}

export function groupingPrompt(
  c: Common,
  keys: { key: string; summary: string }[],
  toolName: string,
): string {
  return buildPrompt({
    task: [
      "Участники совета назвали свои решения разными ключами. Определи, какие ключи означают одно и то же решение по сути (а не просто похожи словами).",
      "Верни groups: каждый ключ ровно в одной группе; разные по сути решения — в разных группах.",
    ].join("\n"),
    data: [
      { name: "question", content: c.question },
      { name: "keys", content: keys.map((k) => `- ${k.key}: ${k.summary}`).join("\n") },
    ],
    toolName,
    nonce: c.nonce,
  });
}
