import { createHash } from "node:crypto";

/**
 * Анонимизация и воспроизводимое перемешивание: метки A/B/C вместо имён моделей,
 * порядок определяется seed'ом из run_id, поэтому повторный прогон даёт тот же порядок.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function aliasFor(index: number): string {
  if (index < LETTERS.length) return LETTERS.charAt(index);
  return `${LETTERS.charAt(index % LETTERS.length)}${Math.floor(index / LETTERS.length)}`;
}

/** Детерминированный ГПСЧ (mulberry32) от строкового seed. */
export function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Перемешивание Фишера — Йетса по seed; исходный массив не меняется. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}
