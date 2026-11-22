import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../src/core/config.js";
import { deliberate } from "../src/core/deliberate.js";
import { sha256 } from "../src/core/state/files.js";
import { critique, proposal, revision, synthesis } from "./consensus-builders.js";
import { FakeDriver, type FakeReply, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps, gitRepo } from "./helpers.js";

const KEY = "partition-by-month";
const ALL = ["A", "B", "C"];
const withPlan: FakeReply = {
  value: {
    ...(synthesis(KEY) as { value: Record<string, unknown> }).value,
    plan: [
      {
        step: "Миграция партиций",
        details: "декларативно, по месяцам",
        files: ["db/migrations/0042.sql"],
      },
    ],
    confirmation: "EXPLAIN показывает partition pruning",
  },
};

function script(synth: FakeReply, severity: "minor" | "major" = "minor"): FakeScript {
  const confidence = 0.8;
  const seat = () => ({
    propose: [proposal(KEY, confidence)],
    "critique-1": [critique(ALL, { severity })],
    "revise-1": [revision(KEY, confidence)],
    synthesize: [synth, synth],
  });
  return { "model-a": seat(), "model-b": seat(), "model-c": seat() };
}

function repo(): { dir: string; config: CouncilConfig } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "council-ho-")));
  gitRepo(dir);
  return { dir, config: loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir })) };
}

describe("handoff plan-only", () => {
  it("одобренный план: worktree с веткой council/<run_id>, PLAN.md и копия ADR; основная копия чистая", async () => {
    const { dir, config } = repo();
    const r = await deliberate(
      { mode: "consensus", question: "Партиционирование платежей", handoff: "plan-only" },
      { config, driver: new FakeDriver(script(withPlan)), runId: "20261122-h00001" },
    );
    expect(r.gate.passed).toBe(true);
    expect(r).toMatchObject({
      branch: "council/20261122-h00001",
      worktree_path: ".council/worktrees/20261122-h00001",
      plan_path: ".council/worktrees/20261122-h00001/PLAN.md",
    });
    const plan = readFileSync(join(dir, r.plan_path!), "utf8");
    expect(plan).toMatch(/^# План: Партиционирование платежей/);
    expect(plan).toContain(
      "1. [ ] **Миграция партиций** — декларативно, по месяцам\n   Файлы: `db/migrations/0042.sql`",
    );
    expect(plan).toContain("## Как проверить\n\nEXPLAIN показывает partition pruning");
    expect(readFileSync(join(dir, r.worktree_path!, r.adr_path!), "utf8")).toBe(
      readFileSync(join(dir, r.adr_path!), "utf8"),
    );
    expect(r.report).toMatch(/Handoff: .*PLAN\.md · ветка council\/20261122-h00001/);
    // в основной копии — только новый ADR (его коммитит человек), .council исключён из git
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString()).toBe(
      "?? docs/\n",
    );
  });

  it("гейт не пройден — план не передаётся; handoff только для consensus", async () => {
    const { config } = repo();
    const weak = await deliberate(
      { mode: "consensus", question: "q", handoff: "plan-only" },
      { config, driver: new FakeDriver(script(withPlan, "major")), runId: "20261122-h00002" },
    );
    expect(weak.gate.passed).toBe(false);
    expect(weak.worktree_path).toBeUndefined();
    expect(weak.warnings).toContain("план не передан в worktree: гейт не пройден");
    await expect(
      deliberate(
        { mode: "vote", question: "q", options: ["a", "b"], handoff: "plan-only" },
        { config, driver: new FakeDriver({}), runId: "r" },
      ),
    ).rejects.toThrow(/только для consensus/);
  });
});

describe("служебные файлы .council", () => {
  it("decisions.json — индекс решений; integrity.json — SHA-256 ADR и транскрипта", async () => {
    const { dir, config } = repo();
    const r = await deliberate(
      { mode: "consensus", question: "Партиционирование" },
      { config, driver: new FakeDriver(script(synthesis(KEY))), runId: "20261122-s00001" },
    );
    const decisions = JSON.parse(readFileSync(join(dir, ".council/decisions.json"), "utf8")) as {
      decisions: Record<string, unknown>[];
    };
    expect(decisions.decisions).toEqual([
      expect.objectContaining({
        run_id: "20261122-s00001",
        mode: "consensus",
        status: "converged",
        adr_path: r.adr_path,
        gate_passed: true,
      }),
    ]);
    const integrity = JSON.parse(readFileSync(join(dir, ".council/integrity.json"), "utf8")) as {
      files: Record<string, { sha256: string }>;
    };
    expect(integrity.files[r.adr_path!]?.sha256).toBe(sha256(readFileSync(join(dir, r.adr_path!))));
    expect(integrity.files[r.transcript_path]?.sha256).toBe(
      sha256(readFileSync(join(dir, r.transcript_path))),
    );
  });
});

describe("discover", () => {
  it("исследования участников объединяются; гейт — кворум; без ADR", async () => {
    const { config } = repo();
    const research = (fact: string): FakeReply => ({
      value: {
        findings: [
          { fact, source: "db/schema.sql:3" },
          { fact: "общий факт", source: "README.md:1" },
        ],
        constraints: ["PostgreSQL 16"],
        options: [{ key: KEY, summary: "по месяцам" }],
        unknowns: ["срок хранения"],
      },
    });
    const r = await deliberate(
      { mode: "discover", question: "Как партиционировать платежи?" },
      {
        config,
        driver: new FakeDriver({
          "model-a": { discover: [research("факт A")] },
          "model-b": { discover: [research("факт B")] },
          "model-c": { discover: [{ error: "timeout" }, { error: "timeout" }] },
        }),
        runId: "20261122-d00001",
      },
    );
    expect(r.status).toBe("majority");
    expect(r.gate.passed).toBe(true);
    expect(r.adr_path).toBeUndefined();
    expect(r.discover?.findings.find((f) => f.fact === "общий факт")?.by).toHaveLength(2);
    expect(r.discover?.options).toHaveLength(1);
    expect(r.discover?.options[0]).toMatchObject({ key: KEY });
    expect(r.discover?.options[0]?.by).toHaveLength(2);
    expect(r.report).toMatch(/Находки: 3 · варианты: partition-by-month \(2\) · неизвестно: 1/);
    expect(r.open_questions).toEqual(["срок хранения"]);
  });
});
