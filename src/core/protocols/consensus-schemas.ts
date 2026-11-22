import { z } from "zod";

import type { AnswerTool } from "../participant.js";

/**
 * Схемы раундов consensus (по образцу llm-council): предложение → анонимная перекрёстная
 * критика → доработка → синтез председателя. Судья группирует решения, если ключи разные.
 */

const SEVERITIES = ["critical", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, items = 12) => z.array(text(max)).max(items);

export const decisionKey = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "латиница в нижнем регистре, цифры и дефисы (kebab-case)")
  .describe("Короткий идентификатор варианта, например pg-partition-by-month");

export const ProposalSchema = z.object({
  decision_key: decisionKey,
  summary: text(800).describe("Суть решения в 1–3 предложениях"),
  design: text(12_000).describe("Описание решения в markdown со ссылками path:line"),
  alternatives: z
    .array(z.object({ key: decisionKey, summary: text(400), why_not: text(600) }))
    .max(6)
    .describe("Рассмотренные и отвергнутые варианты"),
  risks: z
    .array(
      z.object({ risk: text(600), severity: z.enum(SEVERITIES), mitigation: text(600).optional() }),
    )
    .max(12),
  assumptions: list(400),
  open_questions: list(400),
  confidence: z.number().min(0).max(1).describe("Уверенность в решении от 0 до 1"),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const RevisionSchema = ProposalSchema.extend({
  changes: z
    .array(
      z.object({
        what: text(400),
        why: text(600),
        triggered_by: z
          .string()
          .trim()
          .min(1)
          .max(8)
          .describe("Метка предложения-критика, чей аргумент учтён"),
      }),
    )
    .max(12)
    .describe("Что изменилось после критики и под влиянием чьего аргумента"),
});
export type Revision = z.infer<typeof RevisionSchema>;

export const FlawSchema = z.object({
  text: text(800),
  severity: z.enum(SEVERITIES),
  veto: z
    .boolean()
    .optional()
    .describe("Вето — только для critical и только если твоя роль даёт право вето"),
});

export const CritiqueSchema = z.object({
  reviews: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(8).describe("Метка предложения"),
        strengths: list(400, 8),
        flaws: z.array(FlawSchema).max(10),
        questions: list(400, 6),
      }),
    )
    .min(1)
    .max(12),
  ranking: z.array(z.string().trim().min(1).max(8)).min(1).describe("Метки от лучшего к худшему"),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export const SynthesisSchema = z.object({
  decision: text(1_200).describe("Итоговое решение в 1–3 предложениях"),
  decision_key: decisionKey,
  rationale: text(6_000),
  rejected_options: z.array(z.object({ key: decisionKey, why: text(800) })).max(8),
  risks: z
    .array(
      z.object({ risk: text(600), severity: z.enum(SEVERITIES), mitigation: text(600).optional() }),
    )
    .max(12),
  open_questions: list(400),
  plan: z
    .array(
      z.object({
        step: text(300),
        details: text(1_500),
        files: z.array(text(300)).max(20).describe("Файлы, которые затронет шаг"),
      }),
    )
    .max(20)
    .optional()
    .describe("План работ по шагам — обязателен для goal plan/implement"),
  confirmation: text(1_500)
    .optional()
    .describe("Как проверить, что решение внедрено и работает: тест, метрика, ревью"),
  dissent: text(2_000)
    .optional()
    .describe("Особое мнение меньшинства — обязательно, если решение не единогласно"),
  confidence: z.number().min(0).max(1),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

export const ResearchSchema = z.object({
  findings: z
    .array(z.object({ fact: text(600), source: text(300).describe("path:line или [inference]") }))
    .max(20),
  constraints: list(400),
  options: z.array(z.object({ key: decisionKey, summary: text(600) })).max(8),
  unknowns: list(400),
});
export type Research = z.infer<typeof ResearchSchema>;

export const GroupingSchema = z.object({
  groups: z
    .array(z.array(decisionKey).min(1))
    .min(1)
    .describe(
      "Ключи, означающие одно и то же решение, — в одной группе; каждый ключ ровно в одной группе",
    ),
  reason: text(1_000),
});
export type Grouping = z.infer<typeof GroupingSchema>;

export const TOOLS = {
  proposal: {
    name: "submit_proposal",
    description:
      "Сдать предложение совета: ключ решения, суть, дизайн, альтернативы, риски, уверенность.",
    schema: ProposalSchema,
  },
  critique: {
    name: "submit_critique",
    description:
      "Сдать критику чужих предложений: сильные стороны, недостатки с серьёзностью, вопросы и рейтинг.",
    schema: CritiqueSchema,
  },
  revision: {
    name: "submit_revision",
    description:
      "Сдать доработанное предложение и список изменений с меткой критика, чей аргумент учтён.",
    schema: RevisionSchema,
  },
  synthesis: {
    name: "submit_synthesis",
    description:
      "Сдать итог совета: решение, обоснование, отвергнутые варианты, риски, вопросы, особое мнение.",
    schema: SynthesisSchema,
  },
  research: {
    name: "submit_research",
    description:
      "Сдать результаты исследования: факты с источниками, ограничения, варианты, неизвестные.",
    schema: ResearchSchema,
  },
  grouping: {
    name: "submit_grouping",
    description: "Сгруппировать ключи решений, которые означают одно и то же.",
    schema: GroupingSchema,
  },
} satisfies Record<string, AnswerTool>;

export const consensusTools = (): AnswerTool[] => Object.values(TOOLS);
