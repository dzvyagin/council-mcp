import { buildContext, type ContextInput } from "../context/builder.js";
import type { CouncilSession, Seat } from "../engine.js";
import { quorumNeeded } from "../gates.js";
import { newNonce } from "../prompts/common.js";
import {
  debateTurnPrompt,
  extractOptionsPrompt,
  judgePrompt,
  renderTurns,
  type DebateCommon,
} from "../prompts/debate.js";
import type { RunStatus } from "../types.js";
import {
  DEBATE_TOOLS,
  DEFAULT_CRITERIA,
  type DebateTurn,
  type Judgement,
} from "./debate-schemas.js";

/**
 * Debate: два участника защищают варианты (proposer — первый, opponent — второй) по раундам,
 * судьи оценивают по критериям. swap_sides — второй прогон с обменом сторон: если победитель
 * меняется вместе со сторонами, исход зависел от роли, а не от вариантов (tie).
 */

export interface DebateInput extends ContextInput {
  question: string;
  options?: string[];
  criteria?: string[];
  rounds?: number;
  swapSides?: boolean;
}

export interface DebatePass {
  /** Метка, защищавшая первый вариант, и метка — второй. */
  sides: { first: string; second: string };
  turns: { side: string; round: number; turn: DebateTurn }[];
  judgements: Map<string, Judgement>;
  winner?: 0 | 1;
  confidence: number;
}

export interface DebateOutcome {
  status: RunStatus;
  options: [string, string];
  criteria: string[];
  winner?: string;
  score: number;
  passes: DebatePass[];
  /** Средние баллы по критериям за все прогоны: [первый, второй]. */
  scores: { criterion: string; first: number; second: number }[];
  rationale: string;
  dissent?: string;
  conditions: string[];
  roles: Map<string, string>;
  warnings: string[];
}

export const DEFAULT_DEBATE_ROUNDS = 2;

/** Дебатёры — первые два места с разными моделями (если можно), судьи — остальные. */
export function debateRoles(seats: Seat[]): { debaters: [Seat, Seat]; judges: Seat[] } | undefined {
  const first = seats[0];
  if (!first) return undefined;
  const second = seats.find((s) => s !== first && s.model.id !== first.model.id) ?? seats[1];
  if (!second) return undefined;
  const rest = seats.filter((s) => s !== first && s !== second);
  // Судьи по возможности — модели, которых нет среди дебатёров.
  const judges = [
    ...rest.filter((s) => s.model.id !== first.model.id && s.model.id !== second.model.id),
    ...rest.filter((s) => s.model.id === first.model.id || s.model.id === second.model.id),
  ];
  return { debaters: [first, second], judges };
}

/** Вердикт судей: большинство голосов с весом по уверенности. */
export function aggregateJudges(judgements: Judgement[]): { winner?: 0 | 1; confidence: number } {
  const weight = [0, 0];
  for (const j of judgements) {
    if (j.winner === "first") weight[0] = (weight[0] ?? 0) + j.confidence;
    if (j.winner === "second") weight[1] = (weight[1] ?? 0) + j.confidence;
  }
  const [a, b] = weight as [number, number];
  const total = judgements.reduce((s, j) => s + j.confidence, 0);
  if (Math.abs(a - b) < 1e-9) return { confidence: 0 };
  const winner = a > b ? 0 : 1;
  return { winner, confidence: total > 0 ? Math.max(a, b) / total : 0 };
}

/** Роли дебатов берутся из мест, уже перемешанных по seed запуска. */
export async function runDebate(
  session: CouncilSession,
  input: DebateInput,
): Promise<DebateOutcome> {
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
  const criteria = input.criteria && input.criteria.length > 0 ? input.criteria : DEFAULT_CRITERIA;
  const warnings: string[] = [];
  const empty = (status: RunStatus, options: [string, string] = ["", ""]): DebateOutcome => ({
    status,
    options,
    criteria,
    score: 0,
    passes: [],
    scores: [],
    rationale: "",
    conditions: [],
    roles: roleOf,
    warnings,
  });

  const roles = debateRoles(session.activeSeats);
  if (!roles || roles.judges.length === 0) {
    warnings.push("для debate нужно минимум три места: два участника и судья");
    return empty("failed");
  }
  const { debaters, judges } = roles;
  if (new Set([...debaters, ...judges].map((s) => s.model.id)).size < 2) {
    warnings.push("все роли играет одна модель: решение не проходит гейт");
  }

  // Варианты: из входа или одним предварительным вызовом.
  let options: [string, string];
  if (input.options?.length === 2) {
    options = [input.options[0] ?? "", input.options[1] ?? ""];
  } else {
    const extractor = judges[0] as Seat;
    const got = await session.askAll(
      "options",
      (seat) => ({
        tool: DEBATE_TOOLS.options,
        prompt: extractOptionsPrompt(common(seat), DEBATE_TOOLS.options.name),
      }),
      (seat) => seat.alias === extractor.alias,
    );
    const extracted = got.get(extractor.alias);
    if (!extracted) {
      warnings.push("не удалось выделить два варианта — передайте options");
      return empty("failed");
    }
    options = extracted.options;
  }

  const rounds = input.rounds ?? DEFAULT_DEBATE_ROUNDS;
  const passes: DebatePass[] = [];
  const order: [Seat, Seat][] = input.swapSides
    ? [debaters, [debaters[1], debaters[0]]]
    : [debaters];

  for (const [pi, [forFirst, forSecond]] of order.entries()) {
    const pass: DebatePass = {
      sides: { first: forFirst.alias, second: forSecond.alias },
      turns: [],
      judgements: new Map(),
      confidence: 0,
    };
    const label = (alias: string) =>
      alias === forFirst.alias ? `${alias} за первый вариант` : `${alias} за второй вариант`;
    for (let r = 1; r <= rounds; r++) {
      const history = renderTurns(pass.turns.map((t) => ({ ...t, side: label(t.side) })));
      const turns = await session.askAll(
        `debate-${String(pi + 1)}-${String(r)}`,
        (seat) => {
          const mine = seat.alias === forFirst.alias ? 0 : 1;
          return {
            role: roleOf.get(seat.alias) ?? "",
            tool: DEBATE_TOOLS.turn,
            prompt: debateTurnPrompt(
              common(seat),
              options[mine],
              options[1 - mine] as string,
              r,
              history,
              DEBATE_TOOLS.turn.name,
            ),
          };
        },
        (seat) => seat.alias === forFirst.alias || seat.alias === forSecond.alias,
      );
      if (turns.size < 2) {
        warnings.push(`в раунде ${String(r)} ответила только одна сторона — дебаты остановлены`);
        return {
          ...empty(turns.size === 0 && pass.turns.length === 0 ? "failed" : "partial", options),
          passes,
        };
      }
      for (const alias of [forFirst.alias, forSecond.alias]) {
        const t = turns.get(alias);
        if (t) pass.turns.push({ side: alias, round: r, turn: t });
      }
    }

    const history = renderTurns(pass.turns.map((t) => ({ ...t, side: label(t.side) })));
    pass.judgements = await session.askAll(
      `judge-${String(pi + 1)}`,
      (seat) => ({
        role: roleOf.get(seat.alias) ?? "",
        tool: DEBATE_TOOLS.judgement,
        prompt: judgePrompt(
          common(seat),
          options[0],
          options[1],
          criteria,
          history,
          DEBATE_TOOLS.judgement.name,
        ),
      }),
      (seat) => judges.some((j) => j.alias === seat.alias),
    );
    const needed = quorumNeeded(judges.length);
    if (pass.judgements.size < needed) {
      warnings.push(
        `нет кворума судей: ответили ${String(pass.judgements.size)} из ${String(judges.length)}, нужно ${String(needed)}`,
      );
      return { ...empty("quorum_failed", options), passes: [...passes, pass] };
    }
    const verdict = aggregateJudges([...pass.judgements.values()]);
    if (verdict.winner !== undefined) pass.winner = verdict.winner;
    pass.confidence = verdict.confidence;
    passes.push(pass);
  }

  const winners = passes.map((p) => p.winner);
  const agreed = winners.every((w) => w !== undefined && w === winners[0]);
  const winnerIdx = agreed ? winners[0] : undefined;
  const allJudgements = passes.flatMap((p) => [...p.judgements.values()]);
  const scores = criteria.map((criterion) => {
    const rows = allJudgements.flatMap((j) => j.scores.filter((s) => s.criterion === criterion));
    const avg = (pick: (s: (typeof rows)[number]) => number) =>
      rows.length > 0 ? rows.reduce((sum, s) => sum + pick(s), 0) / rows.length : 0;
    return { criterion, first: avg((s) => s.first), second: avg((s) => s.second) };
  });

  let status: RunStatus;
  if (winnerIdx === undefined) {
    status = "tie";
    if (passes.length > 1 && winners.every((w) => w !== undefined)) {
      warnings.push(
        "при обмене сторон победитель сменился — исход зависел от роли, а не от вариантов",
      );
    } else {
      warnings.push("судьи не определили победителя — запустите consensus");
    }
  } else {
    const unanimous = allJudgements.every(
      (j) => j.winner === (winnerIdx === 0 ? "first" : "second"),
    );
    status = unanimous ? "converged" : "majority";
  }
  const score =
    winnerIdx === undefined ? 0 : passes.reduce((s, p) => s + p.confidence, 0) / passes.length;
  const lead = allJudgements[0];
  const strongestLoser =
    winnerIdx === undefined || !lead
      ? undefined
      : winnerIdx === 0
        ? lead.strongest_second
        : lead.strongest_first;
  const dissenting = allJudgements.filter(
    (j) => winnerIdx !== undefined && j.winner !== (winnerIdx === 0 ? "first" : "second"),
  );

  return {
    status,
    options,
    criteria,
    ...(winnerIdx !== undefined && { winner: options[winnerIdx] }),
    score,
    passes,
    scores,
    rationale: allJudgements.map((j) => j.rationale).join("\n\n"),
    ...((strongestLoser !== undefined || dissenting.length > 0) && {
      dissent: [
        ...(strongestLoser !== undefined
          ? [`Сильнейший довод проигравшего варианта: ${strongestLoser}`]
          : []),
        ...dissenting.map((j) => `Судья против: ${j.rationale}`),
      ].join("\n"),
    }),
    conditions: [...new Set(allJudgements.flatMap((j) => j.conditions))].slice(0, 6),
    roles: roleOf,
    warnings,
  };
}
