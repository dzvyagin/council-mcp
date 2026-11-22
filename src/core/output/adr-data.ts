import type { ConsensusOutcome } from "../protocols/consensus.js";
import type { VoteTally } from "../protocols/vote.js";
import type { ParticipantSummary, VoteRecord } from "../types.js";
import type { AdrData, AdrOption, AdrParticipant } from "./adr.js";

/** Сборка данных ADR из итогов протоколов. */

type Base = Pick<
  AdrData,
  | "title"
  | "date"
  | "runId"
  | "mode"
  | "transcript"
  | "status"
  | "score"
  | "gate"
  | "question"
  | "notes"
  | "warnings"
>;

const MAX_POINTS = 6;
const uniq = (items: string[]) => [...new Set(items)].slice(0, MAX_POINTS);

function participants(
  summaries: ParticipantSummary[],
  positions: Map<string, { key: string; confidence: number }>,
  roles: Map<string, string>,
): AdrParticipant[] {
  return summaries.map((p) => {
    const pos = positions.get(p.alias);
    const role = roles.get(p.alias)?.split(" — ")[0];
    return {
      alias: p.alias,
      ...(role !== undefined && { role }),
      ...(pos && { position: pos.key, confidence: pos.confidence }),
      state: p.state,
      ...(p.note !== undefined && { note: p.note }),
    };
  });
}

export function consensusAdr(
  base: Base,
  outcome: ConsensusOutcome,
  summaries: ParticipantSummary[],
): AdrData {
  const byKey = new Map<string, AdrOption>();
  for (const p of outcome.positions) {
    const option = byKey.get(p.key) ?? {
      key: p.key,
      summary: outcome.finals.get(p.alias)?.summary ?? "",
      supporters: [],
      pros: [],
      cons: [],
    };
    option.supporters.push(p.alias);
    for (const critique of outcome.critiques.values()) {
      for (const review of critique.reviews.filter((r) => r.label === p.alias)) {
        option.pros.push(...review.strengths);
        option.cons.push(...review.flaws.map((f) => `[${f.severity}] ${f.text}`));
      }
    }
    byKey.set(p.key, option);
  }
  const options = [...byKey.values()].map((o) => ({
    ...o,
    pros: uniq(o.pros),
    cons: uniq(o.cons),
  }));
  const s = outcome.synthesis;
  const fallbackRisks = [...outcome.finals.values()].flatMap((f) => f.risks);
  const positions = new Map(
    outcome.positions.map((p) => [p.alias, { key: p.key, confidence: p.confidence }]),
  );

  return {
    ...base,
    decision: outcome.decision,
    ...(outcome.decisionKey !== undefined && { decisionKey: outcome.decisionKey }),
    ...(s?.rationale !== undefined && { rationale: s.rationale }),
    options,
    rejected: s?.rejected_options ?? [],
    risks: s?.risks ?? fallbackRisks.slice(0, 12),
    ...(s?.confirmation !== undefined && { confirmation: s.confirmation }),
    ...(s?.dissent !== undefined && { dissent: s.dissent }),
    openQuestions:
      s?.open_questions ?? uniq([...outcome.finals.values()].flatMap((f) => f.open_questions)),
    participants: participants(summaries, positions, outcome.roles),
  };
}

export function voteAdr(
  base: Base,
  tally: VoteTally,
  votes: VoteRecord[],
  options: string[] | undefined,
  dissent: string | undefined,
  summaries: ParticipantSummary[],
): AdrData {
  const choices = options ?? [...new Set(votes.map((v) => v.choice))];
  const adrOptions: AdrOption[] = choices.map((choice) => {
    const supporters = votes.filter((v) => v.choice === choice);
    return {
      key: choice,
      summary: choice,
      supporters: supporters.map((v) => v.alias),
      pros: uniq(supporters.map((v) => v.rationale)),
      cons: [],
    };
  });
  const winners = votes.filter((v) => v.choice === tally.winner);
  const positions = new Map(
    votes.map((v) => [v.alias, { key: v.choice, confidence: v.confidence }]),
  );
  return {
    ...base,
    decision: tally.winner ?? "Голоса разделились — решение не выбрано.",
    ...(winners.length > 0 && {
      rationale: winners.map((v) => `${v.alias}: ${v.rationale}`).join("\n\n"),
    }),
    options: adrOptions,
    rejected: [],
    risks: [],
    ...(dissent !== undefined && { dissent }),
    openQuestions: [],
    participants: participants(summaries, positions, new Map()),
  };
}
