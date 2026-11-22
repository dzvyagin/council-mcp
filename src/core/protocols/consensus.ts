import { shuffle } from "../anonymize.js";
import { buildContext, type ContextInput } from "../context/builder.js";
import {
  assess,
  bordaScores,
  canonicalizer,
  validateGrouping,
  type Convergence,
  type Position,
} from "../convergence.js";
import type { CouncilSession, Seat } from "../engine.js";
import { blockingVeto, consensusScore, openFlaws, quorumNeeded, type OpenFlaw } from "../gates.js";
import { newNonce, type DataBlock } from "../prompts/common.js";
import {
  critiquePrompt,
  groupingPrompt,
  proposePrompt,
  researchPrompt,
  revisePrompt,
  synthesizePrompt,
  type Common,
} from "../prompts/consensus.js";
import type { Goal, RunStatus } from "../types.js";
import type { Style } from "../config.js";
import {
  TOOLS,
  type Critique,
  type Grouping,
  type Proposal,
  type Research,
  type Revision,
  type Synthesis,
} from "./consensus-schemas.js";

/**
 * Consensus: [исследование] → независимые предложения → анонимная перекрёстная критика (модель
 * не критикует своих же персон) → доработка → проверка сходимости (с судьёй, если ключи разные)
 * → повтор до max_rounds → вето и score → синтез председателя.
 */

export interface ConsensusInput extends ContextInput {
  question: string;
  researchFirst?: boolean;
}

export interface ConsensusOptions {
  seed: string;
  maxRounds: number;
  /** Порог средней уверенности большинства. */
  majorityThreshold: number;
  /** Модель председателя из конфига (иначе — лучший рейтинг в критике). */
  chairModelId?: string;
  goal: Goal;
  style: Style;
}

export interface ConsensusOutcome {
  status: RunStatus;
  decision: string;
  decisionKey?: string;
  synthesis?: Synthesis;
  finals: Map<string, Proposal | Revision>;
  positions: Position[];
  convergence?: Convergence;
  /** Недостатки последней итерации, не закрытые доработкой. */
  open: OpenFlaw[];
  score: number;
  veto?: OpenFlaw & { persona: string };
  ratings: Map<string, number>;
  /** Критика последней итерации: критик → отзывы (для плюсов и минусов в ADR). */
  critiques: Map<string, Critique>;
  roles: Map<string, string>;
  research: Map<string, Research>;
  iterations: number;
  quorum: { needed: number; lastRound: number };
  chair?: string;
  warnings: string[];
}

type Answer = Proposal | Revision;

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

export function critiqueRules(others: string[], canVeto = false) {
  return (c: Critique): string | undefined => {
    const labels = c.reviews.map((r) => r.label);
    if (!sameSet(labels, others)) return `reviews должны быть ровно по меткам ${others.join(", ")}`;
    if (!sameSet(c.ranking, others)) {
      return `ranking должен содержать все метки ${others.join(", ")} по одному разу`;
    }
    const vetoes = c.reviews.flatMap((r) => r.flaws).filter((f) => f.veto === true);
    if (vetoes.length > 0 && !canVeto) return "у твоей роли нет права вето: убери veto: true";
    if (vetoes.some((f) => f.severity !== "critical"))
      return "вето возможно только для critical-недостатка";
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

/** Требования к форме итога по goal и style. */
export function outputRules(
  goal: Goal,
  style: Style,
): { rules: string[]; needPlan: boolean; needFiles: boolean } {
  const rules: string[] = [];
  let needPlan = false;
  let needFiles = false;
  if (goal === "advice")
    rules.push("Нужен совет, а не формальное решение: decision — рекомендация в 1–3 предложениях.");
  if (goal === "plan") {
    needPlan = true;
    rules.push("plan обязателен: шаги работ по порядку, у каждого — details.");
  }
  if (goal === "implement" || style === "implementation") {
    needPlan = true;
    needFiles = true;
    rules.push(
      "plan обязателен: шаги реализации по порядку; у каждого шага — files (затрагиваемые файлы) и details.",
    );
  }
  if (goal === "review")
    rules.push("Сфокусируйся на найденных проблемах и их серьёзности; decision — общий вывод.");
  if (style === "executive") {
    rules.push(
      "Пиши для руководителя: decision — решение и главный риск; rationale — не больше пяти предложений; risks — только major и critical.",
    );
  }
  return { rules, needPlan, needFiles };
}

function researchBlock(research: Map<string, Research>): DataBlock {
  const parts = [...research.entries()].map(([label, r]) =>
    [
      `### Исследование ${label}`,
      ...r.findings.map((f) => `- ${f.fact} (${f.source})`),
      ...(r.constraints.length > 0 ? ["Ограничения:", ...r.constraints.map((c) => `- ${c}`)] : []),
      ...(r.options.length > 0
        ? ["Варианты:", ...r.options.map((o) => `- ${o.key}: ${o.summary}`)]
        : []),
      ...(r.unknowns.length > 0 ? ["Неизвестно:", ...r.unknowns.map((u) => `- ${u}`)] : []),
    ].join("\n"),
  );
  return { name: "research", content: parts.join("\n\n") };
}

export async function runConsensus(
  session: CouncilSession,
  input: ConsensusInput,
  options: ConsensusOptions,
): Promise<ConsensusOutcome> {
  const nonce = newNonce();
  const context = buildContext(input);
  const roleOf = new Map(
    session.seats.map((s) => [s.alias, `${s.persona.name} — ${s.persona.focus}`]),
  );
  const common = (seat: Seat): Common => ({
    question: input.question,
    context,
    nonce,
    role: roleOf.get(seat.alias) ?? seat.persona.name,
  });
  const warnings: string[] = [];
  const needed = quorumNeeded(session.seats.length);
  const modelOf = (alias: string) => session.seat(alias)?.model.id;
  const distinctModels = (aliases: Iterable<string>) =>
    new Set([...aliases].map(modelOf).filter(Boolean)).size;

  let ratings = new Map<string, number>();
  let lastCritiques = new Map<string, Critique>();
  let open: OpenFlaw[] = [];
  let grouping: Grouping | undefined;
  let convergence: Convergence | undefined;
  let iterations = 0;
  let research = new Map<string, Research>();
  let lastRound = 0;

  const base = (status: RunStatus, current: Map<string, Answer>): ConsensusOutcome => ({
    status,
    decision: "",
    finals: current,
    positions: positionsOf(current),
    open,
    score: 0,
    ratings,
    critiques: lastCritiques,
    roles: roleOf,
    research,
    iterations,
    quorum: { needed, lastRound },
    warnings,
  });
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
  /** Кворум раунда: ⌊panel/2⌋ + 1 валидных ответов, иначе quorum_failed без синтеза. */
  const quorumOk = (round: string, answers: Map<string, unknown>) => {
    lastRound = answers.size;
    if (answers.size >= needed) return true;
    warnings.push(
      `нет кворума в раунде ${round}: ответили ${String(answers.size)} из ${String(session.seats.length)}, нужно ${String(needed)}`,
    );
    return false;
  };

  // Исследование (research_first): его итог добавляется в общий контекст всех раундов.
  if (input.researchFirst) {
    research = await session.askAll(
      "research",
      (seat) => ({
        role: roleOf.get(seat.alias) ?? "",
        tool: TOOLS.research,
        prompt: researchPrompt(common(seat), TOOLS.research.name),
      }),
      undefined,
      true,
    );
    // Исследование — вспомогательный шаг: без кворума совет продолжает по тому, что есть.
    if (research.size < needed) {
      warnings.push(
        `исследование неполное: ответили ${String(research.size)} из ${String(session.seats.length)} — совет продолжает без него`,
      );
    }
    if (research.size > 0) context.push(researchBlock(research));
  }

  // Раунд 1 — независимые предложения.
  let current: Map<string, Answer> = await session.askAll("propose", (seat) => ({
    role: roleOf.get(seat.alias) ?? "",
    tool: TOOLS.proposal,
    prompt: proposePrompt(common(seat), TOOLS.proposal.name),
  }));
  if (current.size === 0) return base("failed", current);
  if (!quorumOk("propose", current)) return base("quorum_failed", current);

  let budgetStop: string | undefined = session.overBudget();
  while (
    budgetStop === undefined &&
    iterations < options.maxRounds &&
    distinctModels(current.keys()) >= 2
  ) {
    iterations++;
    const labels = [...current.keys()];
    // Модель не критикует своих же персон.
    const othersFor = (seat: Seat) =>
      shuffle(
        labels.filter((l) => modelOf(l) !== seat.model.id),
        `${options.seed}:${String(iterations)}:${seat.alias}`,
      );

    // Раунд 2 — перекрёстная критика.
    const critiques = await session.askAll(
      `critique-${String(iterations)}`,
      (seat) => {
        const others = othersFor(seat);
        return {
          role: roleOf.get(seat.alias) ?? "",
          tool: TOOLS.critique,
          validate: critiqueRules(others, seat.persona.vetoPower),
          prompt: critiquePrompt(
            common(seat),
            others.map((label) => ({ label, proposal: current.get(label) as Answer })),
            TOOLS.critique.name,
            seat.persona.vetoPower,
          ),
        };
      },
      (seat) => current.has(seat.alias) && othersFor(seat).length > 0,
    );
    if (!quorumOk(`critique-${String(iterations)}`, critiques))
      return base("quorum_failed", current);
    budgetStop = session.overBudget();
    if (budgetStop !== undefined) {
      // Текущий раунд (критика) дождались; доработку не запускаем — синтез по предложениям.
      lastCritiques = critiques;
      ratings = bordaScores(critiques);
      open = openFlaws(critiques, new Map());
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
    const revisions = await session.askAll(
      `revise-${String(iterations)}`,
      (seat) => {
        const own = current.get(seat.alias) as Answer;
        const feedback = [...critiques.entries()].flatMap(([critic, c]) =>
          c.reviews.filter((r) => r.label === seat.alias).map((review) => ({ critic, review })),
        );
        return {
          role: roleOf.get(seat.alias) ?? "",
          tool: TOOLS.revision,
          validate: revisionRules(
            own.decision_key,
            feedback.map((f) => f.critic),
          ),
          prompt: revisePrompt(common(seat), own, feedback, place(seat.alias), TOOLS.revision.name),
        };
      },
      (seat) => current.has(seat.alias),
    );
    if (!quorumOk(`revise-${String(iterations)}`, revisions))
      return base("quorum_failed", revisions);
    current = new Map(revisions);
    open = openFlaws(critiques, revisions);
    budgetStop ??= session.overBudget();

    if (distinctModels(current.keys()) < 2) break;
    if (budgetStop === undefined)
      grouping = await groupKeys(session, current, common, ratings, iterations);
    const criticals = open.filter((f) => f.severity === "critical");
    convergence = assess(
      positionsOf(current),
      canonicalizer(grouping),
      criticals,
      options.majorityThreshold,
    );
    if (convergence.status !== "none") break;
  }

  const positions = positionsOf(current);
  if (distinctModels(current.keys()) < 2) {
    const [alias, only] = [...current.entries()][0] as [string, Answer];
    warnings.push("ответила только одна модель: решение не проходит гейт");
    return {
      ...base("partial", current),
      decision: only.summary,
      decisionKey: only.decision_key,
      chair: alias,
    };
  }
  if (convergence === undefined) {
    // max_rounds = 0 или остановка по бюджету: сходимость — по имеющимся позициям.
    const criticals = open.filter((f) => f.severity === "critical");
    convergence = assess(positions, canonicalizer(grouping), criticals, options.majorityThreshold);
  }

  const majority = convergence.status !== "none" ? convergence : undefined;
  let status: RunStatus = majority ? majority.status : "no_consensus";
  if (budgetStop !== undefined) {
    warnings.push(`бюджет исчерпан (${budgetStop}) — итог синтезирован по уже прошедшим раундам`);
    status = "partial";
  }
  const veto = majority ? blockingVeto(open, majority.aliases) : undefined;
  if (veto && status !== "partial") status = "vetoed";
  const score = majority
    ? consensusScore(positions, majority.aliases, open).score
    : convergence.score;

  const unanimous = majority?.status === "converged" && majority.aliases.length === current.size;
  const verdict = veto
    ? `большинство за ${majority?.key ?? "?"}, но наложено вето (${veto.critic}): ${veto.text}. Опиши решение и причину вето.`
    : convergence.status === "none"
      ? `консенсус не достигнут (${convergence.reason}); опиши позиции и что нужно для решения`
      : `${convergence.status}: большинство ${convergence.aliases.join(", ")} за ${convergence.key}${unanimous ? " (единогласно)" : ""}`;

  const canonical = canonicalizer(grouping);
  const form = outputRules(options.goal, options.style);
  const synthRules = (s: Synthesis): string | undefined => {
    if (majority && canonical(s.decision_key) !== majority.key) {
      return `decision_key итога должен соответствовать решению большинства (${majority.key})`;
    }
    if (!unanimous && (s.dissent === undefined || s.dissent.trim() === "")) {
      return "решение не единогласно — заполни dissent";
    }
    if (form.needPlan && (s.plan === undefined || s.plan.length === 0))
      return "заполни plan: шаги работ";
    if (form.needFiles && s.plan?.some((p) => p.files.length === 0))
      return "у каждого шага plan укажи files";
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
    form.rules,
  );
  if (!synthesis)
    warnings.push("синтез председателя не удался — итог собран из позиций участников");
  const decisionKey = synthesis?.decision_key ?? majority?.key;
  const fallback = majority ? current.get(majority.aliases[0] ?? "")?.summary : undefined;
  const vetoPersona = veto ? session.seat(veto.critic)?.persona.name : undefined;

  return {
    ...base(status, current),
    decision: synthesis?.decision ?? fallback ?? "",
    ...(decisionKey !== undefined && { decisionKey }),
    ...(synthesis && { synthesis }),
    convergence,
    score,
    ...(veto && { veto: { ...veto, persona: vetoPersona ?? veto.critic } }),
    ...(chair !== undefined && { chair }),
  };
}

/** Судья группирует разные ключи; одинаковые ключи группировать не нужно. */
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
  rules: string[],
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
          rules,
        ),
      }),
      (seat) => seat.alias === chair.alias,
    );
    const synthesis = answers.get(chair.alias);
    if (synthesis) return { synthesis, chair: chair.alias };
  }
  return {};
}
