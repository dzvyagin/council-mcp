import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { listCases, parseCase, runEval } from "../src/eval/runner.js";
import { critique, proposal, revision, synthesis, times } from "./consensus-builders.js";
import { FakeDriver, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const CASES = fileURLToPath(new URL("../eval/cases", import.meta.url));
const KEY = "partition-by-month";
const ALL = ["A", "B", "C"];

describe("eval", () => {
  it("9 задач разбираются: заголовок, вопрос, ограничения в notes, чек-лист", async () => {
    const files = await listCases(CASES);
    expect(files).toHaveLength(9);
    for (const f of files) {
      const c = parseCase("x", readFileSync(f, "utf8"));
      expect(c.title.length).toBeGreaterThan(5);
      expect(c.question.length).toBeGreaterThan(50);
      expect(c.notes).toMatch(/^Ограничения:/);
      expect(c.checklist.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("слепые пары A/B, ключ с ценой, чек-лист; в ответах нет пометок, кто есть кто", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "council-eval-ws-")));
    const out = join(ws, "out");
    const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: ws }));
    const script = (): FakeScript =>
      Object.fromEntries(
        ["model-a", "model-b", "model-c"].map((m) => [
          m,
          {
            propose: times(3, proposal(KEY)),
            "critique-1": times(3, critique(ALL)),
            "revise-1": times(3, revision(KEY)),
            synthesize: times(3, synthesis(KEY)),
          },
        ]),
      );
    const cases = (await listCases(CASES)).slice(0, 2);
    const summary = await runEval({
      cases,
      outDir: out,
      config,
      makeDriver: () => new FakeDriver(script()),
    });
    expect(summary.cases).toHaveLength(2);
    for (const c of summary.cases) {
      expect(c.single).toMatchObject({ calls: 1, status: "ok" });
      expect(c.council.calls).toBeGreaterThan(c.single.calls);
      const dir = join(out, c.id);
      const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8")) as {
        A: string;
        B: string;
      };
      expect(new Set([key.A, key.B])).toEqual(new Set(["council", "single"]));
      for (const side of ["A.md", "B.md"]) {
        const text = readFileSync(join(dir, side), "utf8");
        expect(text).not.toMatch(/council|совет|одиночн|model-[abc]|Run:/i);
      }
      expect(readFileSync(join(dir, "checklist.md"), "utf8")).toMatch(
        /\| Учтены ограничения задачи \| \|/,
      );
    }
    expect(existsSync(join(out, "summary.json"))).toBe(true);
    expect(existsSync(join(ws, "docs/adr"))).toBe(false); // ADR совета — не в проект
  });
});
