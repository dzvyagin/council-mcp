import { z } from "zod";

import { shuffle } from "../anonymize.js";
import type { PriorDecision } from "../context/prior.js";
import type { CouncilSession } from "../engine.js";
import type { AnswerTool } from "../participant.js";
import { newNonce } from "../prompts/common.js";
import { votePrompt } from "../prompts/vote.js";
import type { RunStatus, VoteRecord } from "../types.js";

/**
 * Vote — один раунд: каждое место возвращает выбор, уверенность и обоснование.
 * Итог — большинство, взвешенное по уверенности. Большинство засчитывается, только если
 * за него проголосовали не меньше двух разных моделей (как кворум семейств у Octopus).
 */

export const VOTE_TOOL_NAME = "submit_vote";

export interface VoteInput {
  question: string;
  options?: string[];
  notes?: string;
  files?: string[];
  prior?: PriorDecision[];
}

export function voteAnswerSchema(options?: string[]) {
  const choice =
    options && options.length > 0
      ? z.enum(options as [string, ...string[]]).describe("Текст выбранного варианта без изменений")
      : z.string().trim().min(1).max(80).describe("Короткий ключ выбора в kebab-case");
  return z.object({
    choice,
    confidence: z.number().min(0).max(1).describe("Уверенность от 0 до 1"),
    rationale: z.string().trim().min(1).max(1500).describe("До пяти предложений с опорой на факты"),
  });
}

export type VoteAnswer = z.infer<ReturnType<typeof voteAnswerSchema>>;

export function voteTool(options?: string[]): AnswerTool<VoteAnswer> {
  return {
    name: VOTE_TOOL_NAME,
    description: "Сдать голос совета: выбор, уверенность и краткое обоснование.",
    schema: voteAnswerSchema(options),
  };
}

export interface TallyVote extends VoteRecord {
  modelId: string;
}

export interface VoteTally {
  status: RunStatus;
  winner?: string;
  score: number;
  /** Вес (сумма уверенности) по каждому выбору, по убыванию. */
  weights: { choice: string; weight: number; votes: number; models: number }[];
  dissent: VoteRecord[];
}

const EPS = 1e-9;

export const normalizeChoice = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

export function tallyVotes(votes: TallyVote[]): VoteTally {
  const models = new Set(votes.map((v) => v.modelId));
  if (votes.length === 0) return { status: "failed", score: 0, weights: [], dissent: [] };

  const groups = new Map<string, { choice: string; weight: number; votes: TallyVote[] }>();
  for (const v of votes) {
    const key = normalizeChoice(v.choice);
    const g = groups.get(key) ?? { choice: v.choice, weight: 0, votes: [] };
    g.weight += v.confidence;
    g.votes.push(v);
    groups.set(key, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.weight - a.weight);
  const weights = ranked.map((g) => ({
    choice: g.choice,
    weight: g.weight,
    votes: g.votes.length,
    models: new Set(g.votes.map((v) => v.modelId)).size,
  }));
  const total = ranked.reduce((s, g) => s + g.weight, 0);
  const top = ranked[0];
  if (!top) return { status: "failed", score: 0, weights, dissent: [] };

  const score = total > EPS ? top.weight / total : 0;
  const dissent = votes.filter((v) => !top.votes.includes(v)).map(stripModel);

  // Осталась одна модель: решение есть, но гейт не пройдёт никогда.
  if (models.size < 2) {
    return { status: "partial", winner: top.choice, score, weights, dissent };
  }

  const topModels = new Set(top.votes.map((v) => v.modelId)).size;
  const second = ranked[1];
  const tiedWithSecond = second !== undefined && Math.abs(second.weight - top.weight) < EPS;
  if (topModels < 2 || tiedWithSecond) {
    return { status: "tie", score, weights, dissent: votes.map(stripModel) };
  }
  return {
    status: ranked.length === 1 ? "converged" : "majority",
    winner: top.choice,
    score,
    weights,
    dissent,
  };
}

const stripModel = ({ alias, choice, confidence, rationale }: TallyVote): VoteRecord => ({
  alias,
  choice,
  confidence,
  rationale,
});

export interface VoteOutcome {
  tally: VoteTally;
  votes: VoteRecord[];
}

export async function runVote(
  session: CouncilSession,
  input: VoteInput,
  seed: string,
): Promise<VoteOutcome> {
  const tool = voteTool(input.options);
  const nonce = newNonce();
  const answers = await session.askAll("vote", (seat) => ({
    tool,
    prompt: votePrompt({
      question: input.question,
      ...(input.options && { options: shuffle(input.options, `${seed}:${seat.alias}`) }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.files && { files: input.files }),
      ...(input.prior && { prior: input.prior }),
      nonce,
      toolName: tool.name,
    }),
  }));

  const votes: TallyVote[] = session.seats.flatMap((seat) => {
    const a = answers.get(seat.alias);
    return a ? [{ alias: seat.alias, modelId: seat.model.id, ...a }] : [];
  });
  return { tally: tallyVotes(votes), votes: votes.map(stripModel) };
}
