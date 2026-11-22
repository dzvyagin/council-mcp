import type { FakeReply } from "./fakes.js";

/** Конструкторы ответов раундов consensus для фейкового драйвера. */

export const proposal = (key: string, confidence = 0.8, summary = `решение ${key}`): FakeReply => ({
  value: {
    decision_key: key,
    summary,
    design: `## ${key}\nСм. db/schema.sql:10`,
    alternatives: [],
    risks: [{ risk: "рост таблицы", severity: "minor" }],
    assumptions: [],
    open_questions: [`вопрос про ${key}`],
    confidence,
  },
});

export interface CritiqueSpec {
  /** Метки по порядку рейтинга; по умолчанию — все чужие в алфавитном порядке. */
  severity?: "critical" | "major" | "minor";
}

/** Критика всех чужих меток из списка участников. */
export const critique = (all: string[], spec: CritiqueSpec = {}): FakeReply => ({
  fn: ({ alias, prompt }) => {
    // Как настоящий участник: рецензирует те метки, что перечислены в задаче.
    const listed = /\(метки ([A-Z0-9, ]+)\)/.exec(prompt)?.[1]?.split(", ");
    const others = listed ?? all.filter((a) => a !== alias);
    return {
      reviews: others.map((label) => ({
        label,
        strengths: ["понятно"],
        flaws: [{ text: `недостаток у ${label}`, severity: spec.severity ?? "minor" }],
        questions: [],
      })),
      ranking: others,
    };
  },
});

export const revision = (
  key: string,
  confidence = 0.8,
  changes: { what: string; why: string; triggered_by: string }[] = [],
): FakeReply => ({
  value: { ...(proposal(key, confidence) as { value: Record<string, unknown> }).value, changes },
});

/** Доработка, меняющая ключ под влиянием первого чужого критика. */
export const switchTo = (key: string, all: string[], confidence = 0.8): FakeReply => ({
  fn: ({ alias }) => ({
    ...(proposal(key, confidence) as { value: Record<string, unknown> }).value,
    changes: [
      {
        what: `перешёл на ${key}`,
        why: "аргумент убедил",
        triggered_by: all.find((a) => a !== alias),
      },
    ],
  }),
});

export const synthesis = (key: string, dissent?: string): FakeReply => ({
  value: {
    decision: `Принять ${key}`,
    decision_key: key,
    rationale: "по аргументам A и B",
    rejected_options: [],
    risks: [],
    open_questions: ["кто владелец миграции?"],
    ...(dissent !== undefined && { dissent }),
    confidence: 0.8,
  },
});

export const grouping = (groups: string[][]): FakeReply => ({
  value: { groups, reason: "по сути" },
});

/** Один и тот же ответ на каждом шаге раунда, на несколько итераций. */
export const times = (n: number, reply: FakeReply): FakeReply[] =>
  Array.from({ length: n }, () => reply);
