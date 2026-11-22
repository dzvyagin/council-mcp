import type { DebateTurn } from "../protocols/debate-schemas.js";
import { buildPrompt, type DataBlock } from "./common.js";

/**
 * Промпты debate и review. Правила дебатов — по образцу ACH (анализ конкурирующих гипотез,
 * Claude Octopus, MIT): доводы с источниками, честные уступки, без спора ради спора.
 */

export interface DebateCommon {
  question: string;
  context: DataBlock[];
  role?: string;
  nonce: string;
}

const withRole = (c: DebateCommon) => (c.role !== undefined ? { role: c.role } : {});

export function renderTurns(turns: { side: string; round: number; turn: DebateTurn }[]): string {
  return turns
    .map(({ side, round, turn }) =>
      [
        `### Раунд ${String(round)} · ${side}`,
        ...turn.arguments.map((a) => `+ ${a.claim} (${a.evidence})`),
        ...turn.rebuttals.map((r) => `× на «${r.target}»: ${r.rebuttal}`),
        ...turn.concessions.map((c) => `= уступка: ${c}`),
      ].join("\n"),
    )
    .join("\n\n");
}

export function debateTurnPrompt(
  c: DebateCommon,
  own: string,
  other: string,
  round: number,
  history: string,
  toolName: string,
): string {
  return buildPrompt({
    ...withRole(c),
    task: [
      `Это дебаты по вопросу из блока QUESTION. Ты защищаешь вариант из блока OWN, оппонент — вариант из блока OTHER. Раунд ${String(round)}.`,
      "Изучи проект и приведи сильнейшие доводы за свой вариант: каждый — с источником path:line или пометкой [inference].",
      "Если в блоке HISTORY есть доводы оппонента — опровергни самые сильные по существу (rebuttals) и честно признай, в чём он прав (concessions).",
      "Не спорь ради спора и не соглашайся без аргумента: оценивай факты проекта, а не стороны.",
    ].join("\n"),
    data: [
      { name: "question", content: c.question },
      { name: "own", content: own },
      { name: "other", content: other },
      ...c.context,
      { name: "history", content: history || "Это первый раунд, реплик ещё нет." },
    ],
    toolName,
    nonce: c.nonce,
  });
}

export function judgePrompt(
  c: DebateCommon,
  first: string,
  second: string,
  criteria: string[],
  history: string,
  toolName: string,
): string {
  return buildPrompt({
    ...withRole(c),
    task: [
      "Ты — судья дебатов по вопросу из блока QUESTION. Первый вариант — блок FIRST, второй — блок SECOND, реплик сторон — блок DEBATE.",
      `Оцени варианты по каждому критерию от 0 до 10: ${criteria.join(", ")}. Проверяй доводы сторон по коду проекта — доводы без подтверждения весят меньше.`,
      "Оценивай варианты, а не красноречие сторон. winner — first, second или tie; confidence — уверенность в вердикте.",
      "strongest_first и strongest_second — сильнейший довод за каждый вариант; conditions — при каких условиях проигравший вариант был бы лучше.",
    ].join("\n"),
    data: [
      { name: "question", content: c.question },
      { name: "first", content: first },
      { name: "second", content: second },
      ...c.context,
      { name: "debate", content: history },
    ],
    toolName,
    nonce: c.nonce,
  });
}

export function extractOptionsPrompt(c: DebateCommon, toolName: string): string {
  return buildPrompt({
    task: "Выдели из вопроса в блоке QUESTION ровно два конкурирующих варианта решения, которые стоит сравнить в дебатах. Формулируй коротко и нейтрально.",
    data: [{ name: "question", content: c.question }, ...c.context],
    toolName,
    nonce: c.nonce,
  });
}

export function reviewPrompt(c: DebateCommon, toolName: string): string {
  return buildPrompt({
    ...withRole(c),
    task: [
      "Проведи ревью изменений из блока DIFF с позиции своей роли. Изучи затронутые файлы проекта целиком, а не только строки диффа.",
      "findings — проблемы с серьёзностью (critical — нельзя выкатывать: уязвимость, потеря данных, поломка; major — существенно; minor — мелочь), файлом и строкой, если применимо. blocker — блокирует ли находка выкатку.",
      "verdict — pass, если изменения можно выкатывать, иначе fail. Не выдумывай проблем, которых нет; не пропускай реальные.",
    ].join("\n"),
    data: [{ name: "question", content: c.question }, ...c.context],
    toolName,
    nonce: c.nonce,
  });
}
