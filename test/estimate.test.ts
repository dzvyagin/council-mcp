import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PER_CALL,
  estimate,
  estimateCalls,
  loadHistory,
  renderEstimate,
} from "../src/core/estimate.js";

const base = {
  mode: "consensus" as const,
  seats: 3,
  maxRounds: 2,
  researchFirst: false,
  contextBytes: 0,
};

describe("estimate", () => {
  it("вызовы: consensus, vote, research_first, max_rounds 0", () => {
    expect(estimateCalls(base)).toEqual({ min: 10, max: 19 });
    expect(estimateCalls({ ...base, researchFirst: true })).toEqual({ min: 13, max: 22 });
    expect(estimateCalls({ ...base, maxRounds: 0 })).toEqual({ min: 4, max: 5 });
    expect(estimateCalls({ ...base, mode: "vote" })).toEqual({ min: 3, max: 3 });
    expect(estimateCalls({ ...base, seats: 7 })).toEqual({ min: 22, max: 39 });
  });

  it("без истории — значения по умолчанию плюс размер контекста", () => {
    const e = estimate({ ...base, contextBytes: 35_000 });
    expect(e.basis).toBe("default");
    expect(e.perCall).toEqual({
      input: DEFAULT_PER_CALL.input + 10_000,
      output: DEFAULT_PER_CALL.output,
    });
    expect(e.tokens.min).toBe(10 * (DEFAULT_PER_CALL.input + 10_000 + DEFAULT_PER_CALL.output));
  });

  it("по истории транскриптов", async () => {
    const dir = mkdtempSync(join(tmpdir(), "council-hist-"));
    mkdirSync(join(dir, "runs"));
    const ask = (input: number, output: number) =>
      JSON.stringify({
        type: "ask",
        usage: { calls: 1, inputTokens: input, outputTokens: output },
      });
    writeFileSync(
      join(dir, "runs/r1.jsonl"),
      [ask(10_000, 1_000), ask(20_000, 1_000), '{"type":"run_finished"}', "broken"].join("\n"),
    );
    writeFileSync(
      join(dir, "runs/r2.jsonl"),
      [ask(30_000, 2_000), ask(0, 0), ask(40_000, 2_000), ask(50_000, 4_000)].join("\n"),
    );
    const h = await loadHistory(dir);
    expect(h).toEqual({ runs: 2, calls: 5, avgInput: 30_000, avgOutput: 2_000 });
    const e = estimate(base, h);
    expect(e.basis).toBe("history");
    expect(e.tokens).toEqual({ min: 10 * 32_000, max: 19 * 32_000 });
    expect(renderEstimate(e)).toBe(
      "Прогноз: 10–19 вызовов · 320k–608k токенов (по истории: 2 запуска; без учёта ретраев)",
    );
    expect(await loadHistory(join(dir, "missing"))).toBeUndefined();
  });
});
