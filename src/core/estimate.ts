import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { formatTokens, plural } from "./output/format.js";
import type { Mode } from "./types.js";

/**
 * Прогноз расхода до запуска. Вызовы — точно по составу панели и числу раундов (без ретраев);
 * токены — средний расход вызова из прошлых транскриптов (.council/runs), а без истории —
 * консервативное значение по умолчанию: участники-агенты сами читают файлы проекта.
 */

export interface EstimateInput {
  mode: Mode;
  seats: number;
  maxRounds: number;
  researchFirst: boolean;
  /** Размер контекста от хоста (notes, diff), байт. */
  contextBytes: number;
}

export interface History {
  runs: number;
  calls: number;
  avgInput: number;
  avgOutput: number;
}

export interface Estimate {
  calls: { min: number; max: number };
  tokens: { min: number; max: number };
  perCall: { input: number; output: number };
  basis: "history" | "default";
  history?: History;
}

/** Без истории: агент читает несколько файлов и держит контекст сессии между раундами. */
export const DEFAULT_PER_CALL = { input: 25_000, output: 1_500 };
const BYTES_PER_TOKEN = 3.5;
const MIN_HISTORY_CALLS = 5;

export function estimateCalls(i: EstimateInput): { min: number; max: number } {
  const research = i.researchFirst ? i.seats : 0;
  if (i.mode === "vote") return { min: research + i.seats, max: research + i.seats };
  const propose = i.seats;
  if (i.maxRounds === 0) return { min: research + propose + 1, max: research + propose + 2 };
  // Лучший случай: сошлись за одну итерацию без судьи. Худший: все итерации + судья + запасной председатель.
  const min = research + propose + 2 * i.seats + 1;
  const max = research + propose + i.maxRounds * (2 * i.seats + 1) + 2;
  return { min, max };
}

export function estimate(i: EstimateInput, history?: History): Estimate {
  const calls = estimateCalls(i);
  const useHistory = history !== undefined && history.calls >= MIN_HISTORY_CALLS;
  const contextTokens = Math.ceil(i.contextBytes / BYTES_PER_TOKEN);
  const perCall = useHistory
    ? { input: Math.round(history.avgInput), output: Math.round(history.avgOutput) }
    : { input: DEFAULT_PER_CALL.input + contextTokens, output: DEFAULT_PER_CALL.output };
  const each = perCall.input + perCall.output;
  return {
    calls,
    tokens: { min: calls.min * each, max: calls.max * each },
    perCall,
    basis: useHistory ? "history" : "default",
    ...(useHistory && { history }),
  };
}

/** Средний расход вызова по транскриптам прошлых запусков. */
export async function loadHistory(stateDir: string, limitRuns = 50): Promise<History | undefined> {
  let files: string[];
  try {
    files = (await readdir(join(stateDir, "runs")))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .slice(-limitRuns);
  } catch {
    return undefined;
  }
  let calls = 0;
  let input = 0;
  let output = 0;
  let runs = 0;
  for (const file of files) {
    let counted = false;
    const text = await readFile(join(stateDir, "runs", file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"ask"')) continue;
      try {
        const entry = JSON.parse(line) as {
          usage?: { calls?: number; inputTokens?: number; outputTokens?: number };
        };
        const u = entry.usage;
        if (!u?.calls || (u.inputTokens ?? 0) === 0) continue;
        calls += u.calls;
        input += u.inputTokens ?? 0;
        output += u.outputTokens ?? 0;
        counted = true;
      } catch {
        // битая строка — пропускаем
      }
    }
    if (counted) runs++;
  }
  if (calls === 0) return undefined;
  return { runs, calls, avgInput: input / calls, avgOutput: output / calls };
}

export function renderEstimate(e: Estimate): string {
  const calls =
    e.calls.min === e.calls.max
      ? String(e.calls.min)
      : `${String(e.calls.min)}–${String(e.calls.max)}`;
  const tokens =
    e.tokens.min === e.tokens.max
      ? formatTokens(e.tokens.min)
      : `${formatTokens(e.tokens.min)}–${formatTokens(e.tokens.max)}`;
  const basis =
    e.basis === "history" && e.history
      ? `по истории: ${String(e.history.runs)} ${plural(e.history.runs, ["запуск", "запуска", "запусков"])}`
      : "по умолчанию, истории запусков нет";
  return `Прогноз: ${calls} ${plural(e.calls.max, ["вызов", "вызова", "вызовов"])} · ${tokens} токенов (${basis}; без учёта ретраев)`;
}
