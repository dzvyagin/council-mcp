import { shuffle } from "../anonymize.js";
import { buildContext, type ContextInput } from "../context/builder.js";
import {
  assess,
  bordaScores,
  canonicalizer,
  unresolvedCriticals,
  validateGrouping,
  type Convergence,
  type Position,
  type Unresolved,
} from "../convergence.js";
import type { CouncilSession, Seat } from "../engine.js";
import { newNonce } from "../prompts/common.js";
import {
  critiquePrompt,
  groupingPrompt,
  proposePrompt,
  revisePrompt,
  synthesizePrompt,
  type Common,
} from "../prompts/consensus.js";
import { roleFor } from "../prompts/roles.js";
import type { RunStatus } from "../types.js";
import {
  TOOLS,
  type Critique,
  type Grouping,
  type Proposal,
  type Revision,
  type Synthesis,
} from "./consensus-schemas.js";

/**
 * Consensus: независимые предложения → анонимная перекрёстная критика → доработка →
 * проверка сходимости (с судьёй, если ключи разные) → повтор до max_rounds → синтез председателя.
 */

export interface ConsensusInput extends ContextInput {
  question: string;
}

export interface ConsensusOptions {
  seed: string;
  maxRounds: number;
  /** Порог средней уверенности большинства. */
  majorityThreshold: number;
  /** Модель председателя из конфига (иначе — лучший рейтинг в критике). */
  chairModelId?: string;
}

export interface ConsensusOutcome {
  status: RunStatus;
  decision: string;
  decisionKey?: string;
  synthesis?: Synthesis;
  finals: Map<string, Proposal | Revision>;
  positions: Position[];
  convergence?: Convergence;
  unresolved: Unresolved[];
  ratings: Map<string, number>;
  /** Критика последней итерации: критик → отзывы (для плюсов и минусов в ADR). */
  critiques: Map<string, Critique>;
  roles: Map<string, string>;
  iterations: number;
  chair?: string;
  warnings: string[];
}

type Answer = Proposal | Revision;

const distinctModels = (session: CouncilSession, aliases: Iterable<string>): number =>
  new Set(
    [...aliases]
      .map((a) => session.seats.find((s) => s.alias === a)?.model.id)
      .filter((id) => id !== undefined),
  ).size;

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

export function critiqueRules(others: string[]) {
  return (c: Critique): string | undefined => {
    const labels = c.reviews.map((r) => r.label);
    if (!sameSet(labels, others)) return `reviews должны быть ровно по меткам ${others.join(", ")}`;
    if (!sameSet(c.ranking, others))
      return `ranking должен содержать все метки ${others.join(", ")} по одному разу`;
    return undefined;
  };
}

export function revisionRules(previousKey: string, critics: string[]) {
  return (r: Revision): string | undefined => {
    const unknown = r.changes.filter((ch) => !critics.includes(ch.triggered_by));
    if (unknown.length > 0) {
      return `triggered_by должен быть меткой одного из критиков: ${critics.join(", ") || "критиков нет"}`;
    }
    if (r.decision_key !== previousKey && r.changes.length === 0) {
      return `decision_key изменён (${previousKey} → ${r.decision_key}) без changes с triggered_by: укажи, чей аргумент убедил`;
    }
    return undefined;
  };
}

export async function runConsensus(
  session: CouncilSession,
  input: ConsensusInput,
  options: ConsensusOptions,
): Promise<ConsensusOutcome> {
  const nonce = newNonce();
  const context = buildContext(input);
  const roleOf = new Map(session.seats.map((s, i) => [s.alias, roleFor(i)]));
  const common = (seat: Seat): Common => ({
    question: input.question,
    context,
    nonce,
    role: roleOf.get(seat.alias) ?? roleFor(0),
  });
  const warnings: string[] = [];

  // Раунд 1 — независимые предложения.
  let current: Map<string, Answer> = await session.askAll("propose", (seat) => ({
    role: roleOf.get(seat.alias) ?? roleFor(0),
    tool: TOOLS.proposal,
    prompt: proposePrompt(common(seat), TOOLS.proposal.name),
  }));

  const positionsOf = (answers: Map<string, Answer>): Position[] =>
    session.seats.flatMap((seat) => {
      const a = answers.get(seat.alias);
      return a
        ? [
            {
              alias: seat.alias,
              modelId: seat.model.id,
              key: a.decision_key,
              confidence: a.confidence,
            },
          ]
        : [];
    });

  let ratings = new Map<string, number>();
  let lastCritiques = new Map<string, Critique>();
  let unresolved: Unresolved[] = [];
  let grouping: Grouping | undefined;
  let convergence: Convergence | undefined;
  let iterations = 0;

  while (iterations < options.maxRounds && distinctModels(session, current.keys()) >= 2) {
    iterations++;
    const labels = [...current.keys()];
    const inPlay = (seat: Seat) => current.has(seat.alias);

    // Раунд 2 — перекрёстная критика: каждому — чужие предложения в своём порядке.
    const critiques = await session.askAll(
      `critique-${String(iterations)}`,
      (seat) => {
        const others = shuffle(
          labels.filter((l) => l !== seat.alias),
          `${options.seed}:${String(iterations)}:${seat.alias}`,
        );
        return {
          role: roleOf.get(seat.alias) ?? roleFor(0),
          tool: TOOLS.critique,
          validate: critiqueRules(others),
          prompt: critiquePrompt(
            common(seat),
            others.map((label) => ({ label, proposal: current.get(label) as Answer })),
            TOOLS.critique.name,
          ),
        };
      },
      inPlay,
    );
    if (critiques.size === 0) {
      warnings.push("критика не получена ни от одного участника");
      break;
    }
    ratings = bordaScores(critiques);
    lastCritiques = critiques;
    const place = (alias: string) => {
      const sorted = [...ratings.entries()].sort((a, b) => b[1] - a[1]);
      const i = sorted.findIndex(([l]) => l === alias);
      const score = ratings.get(alias);
      return i < 0 || score === undefined
        ? "нет оценок"
        : `${String(i + 1)} из ${String(sorted.length)} (балл ${score.toFixed(2)})`;
    };

    // Раунд 3 — доработка: каждому — только критика его предложения.
    const critics = [...critiques.keys()];
    const revisions = await session.askAll(
      `revise-${String(iterations)}`,
      (seat) => {
        const own = current.get(seat.alias) as Answer;
        const feedback = [...critiques.entries()].flatMap(([critic, c]) =>
          c.reviews.filter((r) => r.label === seat.alias).map((review) => ({ critic, review })),
        );
        return {
          role: roleOf.get(seat.alias) ?? roleFor(0),
          tool: TOOLS.revision,
          validate: revisionRules(
            own.decision_key,
            critics.filter((c) => c !== seat.alias),
          ),
          prompt: revisePrompt(common(seat), own, feedback, place(seat.alias), TOOLS.revision.name),
        };
      },
      inPlay,
    );
    current = new Map(revisions);
    unresolved = unresolvedCriticals(critiques, revisions);

    if (distinctModels(session, current.keys()) < 2) break;
    grouping = await groupKeys(session, current, common, ratings, iterations);
    convergence = assess(
      positionsOf(current),
      canonicalizer(grouping),
      unresolved,
      options.majorityThreshold,
    );
    if (convergence.status !== "none") break;
  }

  const positions = positionsOf(current);
  const models = distinctModels(session, current.keys());

  if (current.size === 0) {
    return {
      status: "failed",
      decision: "",
      finals: current,
      positions,
      unresolved,
      ratings,
      critiques: lastCritiques,
      roles: roleOf,
      iterations,
      warnings,
    };
  }
  if (models < 2) {
    const [alias, only] = [...current.entries()][0] as [string, Answer];
    warnings.push("ответила только одна модель: решение не проходит гейт");
    return {
      status: "partial",
      decision: only.summary,
      decisionKey: only.decision_key,
      finals: current,
      positions,
      unresolved,
      ratings,
      critiques: lastCritiques,
      roles: roleOf,
      iterations,
      chair: alias,
      warnings,
    };
  }
  if (iterations === 0) {
    // max_rounds = 0: сразу синтез по предложениям.
    convergence = assess(positions, canonicalizer(grouping), unresolved, options.majorityThreshold);
  }

  const status: RunStatus =
    convergence?.status === "converged" || convergence?.status === "majority"
      ? convergence.status
      : "no_consensus";
  const unanimous =
    convergence?.status === "converged" && convergence.aliases.length === current.size;
  const verdict =
    convergence === undefined
      ? "проверка сходимости не проводилась"
      : convergence.status === "none"
        ? `консенсус не достигнут (${convergence.reason}); опиши позиции и что нужно для решения`
        : `${convergence.status}: большинство ${convergence.aliases.join(", ")} за ${convergence.key}${unanimous ? " (единогласно)" : ""}`;

  const canonical = canonicalizer(grouping);
  const synthRules = (s: Synthesis): string | undefined => {
    if (
      convergence &&
      convergence.status !== "none" &&
      canonical(s.decision_key) !== convergence.key
    ) {
      return `decision_key итога должен соответствовать решению большинства (${convergence.key})`;
    }
    if (!unanimous && (s.dissent === undefined || s.dissent.trim() === "")) {
      return "решение не единогласно — заполни dissent";
    }
    return undefined;
  };

  const { synthesis, chair } = await synthesize(
    session,
    current,
    common,
    ratings,
    options,
    synthRules,
    verdict,
  );
  if (!synthesis)
    warnings.push("синтез председателя не удался — итог собран из позиций участников");
  const majority = convergence && convergence.status !== "none" ? convergence : undefined;
  const decisionKey = synthesis?.decision_key ?? majority?.key;
  const fallback = majority ? current.get(majority.aliases[0] ?? "")?.summary : undefined;

  return {
    status,
    decision: synthesis?.decision ?? fallback ?? "",
    ...(decisionKey !== undefined && { decisionKey }),
    ...(synthesis && { synthesis }),
    finals: current,
    positions,
    ...(convergence && { convergence }),
    unresolved,
    ratings,
    critiques: lastCritiques,
    roles: roleOf,
    iterations,
    ...(chair !== undefined && { chair }),
    warnings,
  };
}

/** Судья группирует разные ключи; одинаковые после нормализации ключи группировать не нужно. */
async function groupKeys(
  session: CouncilSession,
  current: Map<string, Answer>,
  common: (seat: Seat) => Common,
  ratings: Map<string, number>,
  iteration: number,
): Promise<Grouping | undefined> {
  const keys = [...new Set([...current.values()].map((a) => a.decision_key))];
  if (keys.length < 2) return undefined;
  const judge = rankSeats(session, ratings)[0];
  if (!judge) return undefined;
  const summaries = keys.map((key) => ({
    key,
    summary: [...current.values()].find((a) => a.decision_key === key)?.summary ?? "",
  }));
  const answers = await session.askAll(
    `judge-${String(iteration)}`,
    (seat) => ({
      tool: TOOLS.grouping,
      validate: (g: Grouping) => validateGrouping(keys, g),
      prompt: groupingPrompt(common(seat), summaries, TOOLS.grouping.name),
    }),
    (seat) => seat.alias === judge.alias,
  );
  return answers.get(judge.alias);
}

/** Работающие места по убыванию рейтинга критики (без оценок — в конце, в порядке мест). */
function rankSeats(session: CouncilSession, ratings: Map<string, number>): Seat[] {
  return [...session.activeSeats].sort(
    (a, b) => (ratings.get(b.alias) ?? -1) - (ratings.get(a.alias) ?? -1),
  );
}

async function synthesize(
  session: CouncilSession,
  finals: Map<string, Answer>,
  common: (seat: Seat) => Common,
  ratings: Map<string, number>,
  options: ConsensusOptions,
  validate: (s: Synthesis) => string | undefined,
  verdict: string,
): Promise<{ synthesis?: Synthesis; chair?: string }> {
  const ranked = rankSeats(session, ratings);
  const configured = ranked.find((s) => s.model.id === options.chairModelId);
  const candidates = configured ? [configured, ...ranked.filter((s) => s !== configured)] : ranked;

  for (const chair of candidates.slice(0, 2)) {
    const labels = shuffle([...finals.keys()], `${options.seed}:synthesis`);
    const answers = await session.askAll(
      "synthesize",
      (seat) => ({
        tool: TOOLS.synthesis,
        validate,
        prompt: synthesizePrompt(
          common(seat),
          labels.map((label) => ({ label, proposal: finals.get(label) as Answer })),
          verdict,
          TOOLS.synthesis.name,
        ),
      }),
      (seat) => seat.alias === chair.alias,
    );
    const synthesis = answers.get(chair.alias);
    if (synthesis) return { synthesis, chair: chair.alias };
  }
  return {};
}
