import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { formatTokens, plural } from "./output/format.js";

/**
 * Фактический расход по транскриптам `.council/runs/*.jsonl`: по моделям, персонам, режимам
 * и дням. Только токены и вызовы — цен у провайдера нет.
 */

export interface UsageRow {
  key: string;
  runs: number;
  calls: number;
  input: number;
  output: number;
}

export interface UsageReport {
  runs: number;
  total: UsageRow;
  byModel: UsageRow[];
  byPersona: UsageRow[];
  byMode: UsageRow[];
  byDay: UsageRow[];
}

interface Seat {
  alias: string;
  modelId: string;
  persona: string;
}

const row = (key: string): UsageRow => ({ key, runs: 0, calls: 0, input: 0, output: 0 });

export async function collectUsage(
  stateDir: string,
  opts: { sinceDays?: number; now?: number } = {},
): Promise<UsageReport> {
  const since =
    opts.sinceDays !== undefined
      ? (opts.now ?? Date.now()) - opts.sinceDays * 86_400_000
      : undefined;
  let files: string[] = [];
  try {
    files = (await readdir(join(stateDir, "runs"))).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    // запусков ещё не было
  }
  const tables = {
    model: new Map<string, UsageRow>(),
    persona: new Map<string, UsageRow>(),
    mode: new Map<string, UsageRow>(),
    day: new Map<string, UsageRow>(),
  };
  const total = row("всего");
  let runs = 0;

  for (const file of files) {
    const text = await readFile(join(stateDir, "runs", file), "utf8").catch(() => "");
    let seats: Seat[] = [];
    let mode = "?";
    let day = "?";
    // Запуск считается в строке таблицы один раз, сколько бы вызовов в нём ни было.
    const touched = new Map<Map<string, UsageRow>, Set<string>>();
    let counted = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: {
        type?: string;
        ts?: string;
        mode?: string;
        seats?: Seat[];
        alias?: string;
        model?: string;
        usage?: { calls?: number; inputTokens?: number; outputTokens?: number };
      };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      if (e.type === "run_started") {
        seats = e.seats ?? [];
        mode = e.mode ?? "?";
        day = (e.ts ?? "").slice(0, 10) || "?";
        if (since !== undefined && Date.parse(e.ts ?? "") < since) break;
        continue;
      }
      if (e.type !== "ask" || !e.usage) continue;
      const u = {
        calls: e.usage.calls ?? 0,
        input: e.usage.inputTokens ?? 0,
        output: e.usage.outputTokens ?? 0,
      };
      const persona = seats.find((s) => s.alias === e.alias)?.persona ?? "?";
      const add = (table: Map<string, UsageRow>, key: string) => {
        const r = table.get(key) ?? row(key);
        r.calls += u.calls;
        r.input += u.input;
        r.output += u.output;
        const seen = touched.get(table) ?? new Set<string>();
        if (!seen.has(key)) {
          seen.add(key);
          r.runs++;
        }
        touched.set(table, seen);
        table.set(key, r);
      };
      add(tables.model, e.model ?? "?");
      add(tables.persona, persona);
      add(tables.mode, mode);
      add(tables.day, day);
      total.calls += u.calls;
      total.input += u.input;
      total.output += u.output;
      counted = true;
    }
    if (counted) runs++;
  }
  total.runs = runs;
  const sorted = (t: Map<string, UsageRow>) =>
    [...t.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
  return {
    runs,
    total,
    byModel: sorted(tables.model),
    byPersona: sorted(tables.persona),
    byMode: sorted(tables.mode),
    byDay: [...tables.day.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function renderUsage(u: UsageReport): string {
  if (u.runs === 0) return "Запусков с учётом расхода пока нет.";
  const line = (r: UsageRow) =>
    `- ${r.key}: ${String(r.calls)} ${plural(r.calls, ["вызов", "вызова", "вызовов"])} · ${formatTokens(r.input + r.output)} токенов (вход ${formatTokens(r.input)}, выход ${formatTokens(r.output)})`;
  const section = (title: string, rows: UsageRow[]) => [`${title}:`, ...rows.map(line)];
  return [
    `🏛 Council · расход · ${String(u.runs)} ${plural(u.runs, ["запуск", "запуска", "запусков"])} · ${formatTokens(u.total.input + u.total.output)} токенов · ${String(u.total.calls)} ${plural(u.total.calls, ["вызов", "вызова", "вызовов"])}`,
    ...section("По моделям", u.byModel),
    ...section("По режимам", u.byMode),
    ...section("По персонам", u.byPersona),
    ...section("По дням", u.byDay),
    "Цен у провайдера нет — учёт в токенах. Расход субагентов участников не учитывается (нижняя оценка).",
  ].join("\n");
}
