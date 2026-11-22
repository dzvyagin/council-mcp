import { z } from "zod";

import type { AnswerTool } from "../participant.js";

/** Схемы debate (proposer / opponent / judge) и review (go/no-go по диффу). */

const text = (max: number) => z.string().trim().min(1).max(max);
const SEVERITIES = ["critical", "major", "minor"] as const;

export const DEFAULT_CRITERIA = ["корректность", "эксплуатация", "стоимость изменений", "риски"];

export const DebateTurnSchema = z.object({
  arguments: z
    .array(
      z.object({ claim: text(800), evidence: text(400).describe("path:line или [inference]") }),
    )
    .min(1)
    .max(8),
  rebuttals: z
    .array(
      z.object({
        target: text(400).describe("Какой довод оппонента опровергается"),
        rebuttal: text(800),
      }),
    )
    .max(8),
  concessions: z.array(text(600)).max(6).describe("В чём оппонент прав — честно"),
});
export type DebateTurn = z.infer<typeof DebateTurnSchema>;

export const JudgementSchema = z.object({
  scores: z
    .array(
      z.object({
        criterion: text(100),
        first: z.number().min(0).max(10),
        second: z.number().min(0).max(10),
        note: text(600),
      }),
    )
    .min(1)
    .max(10),
  winner: z.enum(["first", "second", "tie"]).describe("Какой вариант лучше: first, second или tie"),
  confidence: z.number().min(0).max(1),
  rationale: text(3_000),
  strongest_first: text(800).describe("Сильнейший довод за первый вариант"),
  strongest_second: text(800).describe("Сильнейший довод за второй вариант"),
  conditions: z
    .array(text(500))
    .max(6)
    .describe("При каких условиях проигравший вариант был бы лучше"),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const OptionsSchema = z.object({
  options: z.tuple([text(300), text(300)]).describe("Ровно два конкурирующих варианта"),
  reason: text(800),
});
export type ExtractedOptions = z.infer<typeof OptionsSchema>;

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  title: text(200),
  file: text(300).optional(),
  line: z.number().int().positive().optional(),
  detail: text(2_000),
  blocker: z.boolean().describe("Блокирует ли выкатку"),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["pass", "fail"]).describe("pass — можно выкатывать; fail — нельзя"),
  summary: text(1_500),
  findings: z.array(FindingSchema).max(30),
});
export type Review = z.infer<typeof ReviewSchema>;

export const DEBATE_TOOLS = {
  turn: {
    name: "submit_debate_turn",
    description: "Сдать реплику в дебатах: доводы с источниками, опровержения, уступки.",
    schema: DebateTurnSchema,
  },
  judgement: {
    name: "submit_judgement",
    description: "Сдать решение судьи: баллы по критериям, победитель, уверенность, обоснование.",
    schema: JudgementSchema,
  },
  options: {
    name: "submit_options",
    description: "Сдать два конкурирующих варианта, выделенных из вопроса.",
    schema: OptionsSchema,
  },
} satisfies Record<string, AnswerTool>;

export const REVIEW_TOOLS = {
  review: {
    name: "submit_review",
    description:
      "Сдать ревью диффа: вердикт pass/fail, итог и находки с серьёзностью и местом в коде.",
    schema: ReviewSchema,
  },
} satisfies Record<string, AnswerTool>;

export const debateTools = (): AnswerTool[] => Object.values(DEBATE_TOOLS);
export const reviewTools = (): AnswerTool[] => Object.values(REVIEW_TOOLS);
