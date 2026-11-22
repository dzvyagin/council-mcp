import type { Critique, Grouping, Revision } from "./protocols/consensus-schemas.js";

/**
 * Сходимость consensus — чистые функции без сети, покрыты тестами.
 *
 * - converged: все позиции в одной группе решений (и за ней ≥ 2 разных модели);
 * - majority: строгое большинство мест в одной группе, ≥ 2 разных модели, средняя уверенность
 *   большинства ≥ порога и нет незакрытых critical против предложений большинства;
 * - иначе — нет сходимости (повтор раундов или no_consensus).
 */

export interface Position {
  alias: string;
  modelId: string;
  key: string;
  confidence: number;
}

export interface Unresolved {
  /** Чьё предложение. */
  target: string;
  /** Кто нашёл недостаток. */
  critic: string;
  text: string;
}

export type Convergence =
  | { status: "converged" | "majority"; key: string; aliases: string[]; score: number }
  | { status: "none"; score: number; reason: string };

/** Рейтинг по Борда: каждый критик упорядочивает чужие предложения; 1 — лучший, 0 — худший. */
export function bordaScores(critiques: Map<string, Critique>): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const critique of critiques.values()) {
    const k = critique.ranking.length;
    critique.ranking.forEach((label, place) => {
      const points = k > 1 ? (k - 1 - place) / (k - 1) : 1;
      const s = sums.get(label) ?? { total: 0, n: 0 };
      sums.set(label, { total: s.total + points, n: s.n + 1 });
    });
  }
  return new Map([...sums].map(([label, s]) => [label, s.total / s.n]));
}

/**
 * Critical-недостаток считается закрытым, если в доработке есть изменение с triggered_by
 * этого критика. Иначе он «висит» и блокирует большинство.
 */
export function unresolvedCriticals(
  critiques: Map<string, Critique>,
  revisions: Map<string, Revision>,
): Unresolved[] {
  const result: Unresolved[] = [];
  for (const [critic, critique] of critiques) {
    for (const review of critique.reviews) {
      const revision = revisions.get(review.label);
      const addressed = revision?.changes.some((c) => c.triggered_by === critic) ?? false;
      if (addressed) continue;
      for (const flaw of review.flaws) {
        if (flaw.severity === "critical")
          result.push({ target: review.label, critic, text: flaw.text });
      }
    }
  }
  return result;
}

/** Проверка группировки судьи: каждый ключ ровно в одной группе, лишних ключей нет. */
export function validateGrouping(keys: string[], grouping: Grouping): string | undefined {
  const seen = grouping.groups.flat();
  const missing = keys.filter((k) => !seen.includes(k));
  const extra = seen.filter((k) => !keys.includes(k));
  const dup = seen.filter((k, i) => seen.indexOf(k) !== i);
  if (missing.length > 0) return `не распределены ключи: ${missing.join(", ")}`;
  if (extra.length > 0) return `лишние ключи: ${extra.join(", ")}`;
  if (dup.length > 0) return `ключ в нескольких группах: ${[...new Set(dup)].join(", ")}`;
  return undefined;
}

/** Ключ → канонический ключ группы (первый ключ группы). Без группировки — сам ключ. */
export function canonicalizer(grouping?: Grouping): (key: string) => string {
  const map = new Map<string, string>();
  for (const group of grouping?.groups ?? []) {
    const head = group[0];
    if (head !== undefined) for (const k of group) map.set(k, head);
  }
  return (key) => map.get(key) ?? key;
}

export function assess(
  positions: Position[],
  canonical: (key: string) => string,
  unresolved: Unresolved[],
  threshold: number,
): Convergence {
  const total = positions.reduce((s, p) => s + p.confidence, 0);
  if (positions.length === 0) return { status: "none", score: 0, reason: "нет позиций" };

  const groups = new Map<string, Position[]>();
  for (const p of positions) {
    const key = canonical(p.key);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const [topKey, top] = ranked[0] as [string, Position[]];
  const weight = top.reduce((s, p) => s + p.confidence, 0);
  const score = total > 0 ? weight / total : 0;
  const models = new Set(top.map((p) => p.modelId)).size;
  const aliases = top.map((p) => p.alias);

  if (ranked.length === 1) {
    if (models >= 2) return { status: "converged", key: topKey, aliases, score };
    return { status: "none", score, reason: "единогласие внутри одной модели не засчитывается" };
  }
  const second = ranked[1]?.[1].length ?? 0;
  if (top.length === second)
    return { status: "none", score, reason: "позиции разделились поровну" };
  if (top.length * 2 <= positions.length)
    return { status: "none", score, reason: "нет строгого большинства" };
  if (models < 2) return { status: "none", score, reason: "большинство — персоны одной модели" };

  const avg = weight / top.length;
  if (avg < threshold) {
    return {
      status: "none",
      score,
      reason: `уверенность большинства ${avg.toFixed(2)} ниже порога ${threshold.toFixed(2)}`,
    };
  }
  const blocking = unresolved.filter((u) => aliases.includes(u.target));
  if (blocking.length > 0) {
    return {
      status: "none",
      score,
      reason: `незакрытые critical против большинства: ${String(blocking.length)}`,
    };
  }
  return { status: "majority", key: topKey, aliases, score };
}
