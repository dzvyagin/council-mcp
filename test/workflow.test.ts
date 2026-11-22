import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../src/core/config.js";
import type { DeliberateInput } from "../src/core/deliberate.js";
import type { DeliberationResult } from "../src/core/types.js";
import { WorkflowError, WorkflowMachine, type PhaseRunner } from "../src/core/workflow/machine.js";
import { createWorktree, WorktreeError } from "../src/core/workflow/worktree.js";
import { baseEnv, fakeDeps, gitRepo } from "./helpers.js";

function workspace(): { dir: string; config: CouncilConfig } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "council-wf-")));
  return { dir, config: loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir })) };
}

/** Фейковый итог совета для фазы. */
function result(over: Partial<DeliberationResult> = {}): DeliberationResult {
  return {
    run_id: "run-1",
    mode: "consensus",
    status: "converged",
    report: "",
    decision: "решение",
    score: 0.9,
    gate: { threshold: 0.75, passed: true },
    participants: [{ alias: "A", personas: [], state: "ok" }],
    open_questions: [],
    votes: [],
    warnings: [],
    transcript_path: ".council/runs/run-1.jsonl",
    usage: { calls: 1, prompt_tokens: 1, completion_tokens: 1, duration_s: 1 },
    ...over,
  };
}

function recorder(byPhase: Record<string, Partial<DeliberationResult>[]>) {
  const calls: { input: DeliberateInput; workspace: string }[] = [];
  const runner: PhaseRunner = (input, ws) => {
    calls.push({ input, workspace: ws });
    const key =
      input.mode === "discover"
        ? "discover"
        : input.mode === "consensus"
          ? "define"
          : input.style === "red-team"
            ? "deliver"
            : "develop";
    const queue = byPhase[key] ?? [];
    return Promise.resolve(result(queue.shift() ?? {}));
  };
  return { calls, runner };
}

const passAll = () => ({
  discover: [
    {
      mode: "discover" as const,
      discover: {
        findings: [{ fact: "2 млрд строк", source: "db/schema.sql:3", by: ["A"] }],
        options: [],
        constraints: [],
        unknowns: [],
      },
    },
  ],
  define: [
    {
      worktree_path: ".council/worktrees/run-1",
      plan_path: ".council/worktrees/run-1/PLAN.md",
      branch: "council/run-1",
      adr_path: "docs/adr/0001-x.md",
    },
  ],
  develop: [
    {
      mode: "review" as const,
      review: { verdict: "go" as const, score: 1, criticals: 0, findings: [] },
    },
  ],
  deliver: [
    {
      mode: "review" as const,
      review: { verdict: "go" as const, score: 1, criticals: 0, findings: [] },
    },
  ],
});

describe("Double Diamond: машина процесса", () => {
  it("сквозной прогон в supervised: каждая фаза ждёт подтверждения, develop и deliver — в worktree", async () => {
    const { dir, config } = workspace();
    const m = new WorkflowMachine({ config, newId: () => "wf-1" });
    const { calls, runner } = recorder(passAll());
    const s = await m.start("Партиционирование платежей", "supervised", {
      notes: "PostgreSQL 16",
      files: ["db/schema.sql"],
    });
    expect(s).toMatchObject({ phase: "discover", status: "ready" });

    const d1 = await m.advance("wf-1", {}, runner);
    expect(d1).toMatchObject({ phase: "discover", gate: { passed: true }, next: "await_user" });
    expect(d1.state.phase).toBe("define");

    const d2 = await m.advance("wf-1", {}, runner);
    expect(d2.state.phases.define).toMatchObject({ status: "passed", branch: "council/run-1" });
    // define получает итог исследования и просит план с handoff в worktree
    expect(calls[1]?.input).toMatchObject({
      mode: "consensus",
      goal: "implement",
      handoff: "plan-only",
      workflowId: "wf-1",
    });
    expect(calls[1]?.input.notes).toContain(
      "Итог исследования (discover):\n- 2 млрд строк (db/schema.sql:3)",
    );

    await expect(m.advance("wf-1", {}, runner)).rejects.toThrow(/для develop нужен дифф/);
    const d3 = await m.advance("wf-1", { diff: "+code" }, runner);
    expect(d3.phase).toBe("develop");
    expect(calls[2]).toMatchObject({
      input: { mode: "review", style: "implementation", diff: "+code" },
      workspace: join(dir, ".council/worktrees/run-1"),
    });

    const d4 = await m.advance("wf-1", { diff: "+code" }, runner);
    expect(calls[3]?.input.style).toBe("red-team");
    expect(d4).toMatchObject({ next: "done" });
    expect(d4.state).toMatchObject({ phase: "done", status: "done" });

    const md = readFileSync(join(dir, ".council/STATE.md"), "utf8");
    expect(md).toContain("- Процесс: `wf-1` — Партиционирование платежей");
    expect(md).toContain("- Фаза: завершён · статус: done · autonomy: supervised");
    expect(md).toMatch(/✓ Deliver — финальная проверка — GO, critical 0/);
    expect(md).toContain("Worktree: `.council/worktrees/run-1` (ветка `council/run-1`)");
  });

  it("провал гейта останавливает процесс с причиной и вариантами; retry, back, override", async () => {
    const { config } = workspace();
    const m = new WorkflowMachine({ config, newId: () => "wf-2" });
    const { runner } = recorder({
      ...passAll(),
      define: [
        { status: "majority", score: 0.6, gate: { threshold: 0.75, passed: false } },
        {
          status: "vetoed",
          gate: {
            threshold: 0.75,
            passed: false,
            veto: { persona: "SRE", reason: "нет плана отката" },
          },
        },
      ],
    });
    await m.start("задача", "semi");
    expect((await m.advance("wf-2", {}, runner)).next).toBe("continue"); // semi: без остановки при успехе

    const failed = await m.advance("wf-2", {}, runner);
    expect(failed).toMatchObject({
      phase: "define",
      next: "gate_failed",
      gate: { passed: false, reason: "majority, score 0.60 < 0.75" },
    });
    expect(failed.state.status).toBe("gate_failed");
    expect(failed.options.join("\n")).toMatch(/retry.*\n.*back.*\n.*override_reason.*\n.*abort/s);

    const vetoed = await m.advance("wf-2", {}, runner); // retry
    expect(vetoed.gate.reason).toBe("вето SRE: нет плана отката");

    const over = await m.advance("wf-2", {}, runner, {
      overrideReason: "план отката есть в runbook",
    });
    expect(over.state.phase).toBe("develop");
    expect(over.state.phases.define).toMatchObject({
      status: "overridden",
      override_reason: "план отката есть в runbook",
    });

    const back = await m.back("wf-2");
    expect(back.phase).toBe("define");
    await expect(m.advance("wf-2", {}, runner, { overrideReason: "x" })).rejects.toThrow(
      /только после провала гейта/,
    );
    expect((await m.abort("wf-2")).status).toBe("aborted");
    await expect(m.advance("wf-2", {}, runner)).rejects.toBeInstanceOf(WorkflowError);
  });

  it("после перезапуска: состояние читается с диска, зависшая фаза снова готова", async () => {
    const { config } = workspace();
    const m = new WorkflowMachine({ config, newId: () => "wf-3" });
    await m.start("задача", "auto");
    let release!: () => void;
    const hanging: PhaseRunner = () =>
      new Promise((r) => {
        release = () => {
          r(result({ mode: "discover" }));
        };
      });
    const pending = m.advance("wf-3", {}, hanging);
    await new Promise((r) => setTimeout(r, 20));

    const fresh = new WorkflowMachine({ config }); // «перезапуск»: новая машина, то же состояние на диске
    const loaded = await fresh.get();
    expect(loaded).toMatchObject({ id: "wf-3", status: "running", phase: "discover" });
    const recovered = await fresh.recover(loaded, () => false);
    expect(recovered.status).toBe("ready");
    expect(recovered.history.at(-1)?.event).toBe("interrupted");
    release();
    await pending;
  });
});

describe("worktree", () => {
  it("создаёт ветку council/<id> с PLAN.md и копией ADR; основная копия не меняется", async () => {
    const { dir, config } = workspace();
    gitRepo(dir);
    const h = await createWorktree(dir, config.paths.stateDir, "run-7", [
      { path: "PLAN.md", content: "# План\n" },
      { path: "docs/adr/0001-x.md", content: "# 0001. x\n" },
    ]);
    expect(h.branch).toBe("council/run-7");
    expect(readFileSync(h.planPath, "utf8")).toBe("# План\n");
    expect(existsSync(join(h.worktreePath, "docs/adr/0001-x.md"))).toBe(true);
    const branches = execFileSync("git", ["branch", "--list", "council/*"], {
      cwd: dir,
    }).toString();
    expect(branches).toContain("council/run-7");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString()).toBe("");
    await expect(createWorktree(dir, config.paths.stateDir, "../bad", [])).rejects.toThrow(
      /недопустимый id/,
    );
  });

  it("не git-репозиторий — понятная ошибка", async () => {
    const { dir, config } = workspace();
    await expect(createWorktree(dir, config.paths.stateDir, "x", [])).rejects.toThrow(
      WorktreeError,
    );
  });
});
