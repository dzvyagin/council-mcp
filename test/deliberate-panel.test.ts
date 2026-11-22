import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../src/core/config.js";
import { BudgetError, deliberate, planRun, type DeliberateInput } from "../src/core/deliberate.js";
import { critique, grouping, proposal, revision, synthesis, times } from "./consensus-builders.js";
import { FakeDriver, type FakeReply, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps, WS } from "./helpers.js";

const config = loadConfig(fakeDeps(baseEnv));
const ALL7 = ["A", "B", "C", "D", "E", "F", "G"];
const X = "partition-by-month";
const Y = "shard-by-tenant";
const MODELS = ["model-a", "model-b", "model-c"];

interface Plan {
  propose: FakeReply;
  critique?: FakeReply;
  revise?: FakeReply;
  synth?: FakeReply;
  research?: FakeReply;
}

/** Каждой модели — по n ответов на раунд (модель может играть несколько персон). */
function script(byModel: Record<string, Plan>, n = 3): FakeScript {
  return Object.fromEntries(
    Object.entries(byModel).map(([model, p]) => [
      model,
      {
        research: times(n, p.research ?? { error: "no_answer" }),
        propose: times(n, p.propose),
        "critique-1": times(n, p.critique ?? critique(ALL7)),
        "revise-1": times(n, p.revise ?? { error: "no_answer" }),
        "judge-1": times(n, grouping([[X], [Y]])),
        "critique-2": times(n, p.critique ?? critique(ALL7)),
        "revise-2": times(n, p.revise ?? { error: "no_answer" }),
        "judge-2": times(n, grouping([[X], [Y]])),
        synthesize: times(2, p.synth ?? synthesis(X, "меньшинство против")),
      },
    ]),
  );
}

const same = (key: string, confidence = 0.8): Plan => ({
  propose: proposal(key, confidence),
  revise: revision(key, confidence),
  synth: synthesis(key),
});

async function run(
  driver: FakeDriver,
  input: Partial<DeliberateInput> = {},
  cfg: CouncilConfig = config,
) {
  return deliberate(
    { mode: "consensus", question: "Как партиционировать платежи?", ...input },
    { config: cfg, driver, runId: "20261122-panel1", artifacts: input.writeAdr === true },
  );
}

describe("consensus: панель, вето, кворум, goal", () => {
  it("panel 5: модель не критикует своих же персон; персоны — в участниках", async () => {
    const driver = new FakeDriver(
      script({ "model-a": same(X), "model-b": same(X), "model-c": same(X) }),
    );
    const r = await run(driver, { panel: 5 });
    expect(r.status).toBe("converged");
    expect(r.participants).toHaveLength(5);
    expect(new Set(r.participants.map((p) => p.personas[0])).size).toBe(5);

    const modelOfAlias = new Map(
      driver.prompts.filter((p) => p.round === "propose").map((p) => [p.alias, p.modelId]),
    );
    for (const p of driver.prompts.filter((q) => q.round === "critique-1")) {
      const reviewed = [...p.prompt.matchAll(/### Предложение ([A-G])\n/g)].map((m) => m[1]!);
      expect(reviewed.length).toBeGreaterThan(0);
      for (const label of reviewed) expect(modelOfAlias.get(label)).not.toBe(p.modelId);
    }
  });

  it("вето SRE/безопасности против большинства, не снятое доработкой, — vetoed, ADR rejected", async () => {
    // red-team: architect, attacker, insider → ни у кого нет вето; balanced panel 3: architect, dba, sre (вето у SRE).
    const vetoAll = critique(ALL7, { veto: true });
    const driver = new FakeDriver(
      script({
        "model-a": { ...same(X), critique: vetoAll },
        "model-b": { ...same(X), critique: vetoAll },
        "model-c": { ...same(X), critique: vetoAll },
      }),
    );
    // Вето может поставить только SRE: остальные получили бы ошибку правил — проверим, что это отклоняется.
    await expect(run(driver)).resolves.toBeDefined();
    const sreOnly = new FakeDriver(
      script(
        Object.fromEntries(MODELS.map((m) => [m, { ...same(X), critique: { fn: vetoIfSre } }])),
      ),
    );
    const r = await run(sreOnly, { writeAdr: true });
    expect(r.status).toBe("vetoed");
    expect(r.gate.passed).toBe(false);
    expect(r.gate.veto?.persona).toBe("SRE");
    expect(r.warnings.some((w) => w.startsWith("вето SRE"))).toBe(true);
    const adr = readFileSync(join(WS, r.adr_path!), "utf8");
    expect(adr).toMatch(/^- Статус: rejected \(council: vetoed — вето SRE: /m);
  });

  it("вето снято доработкой (triggered_by критика) — решение проходит", async () => {
    const plan = (m: string): [string, Plan] => [
      m,
      { ...same(X), critique: { fn: vetoIfSre }, revise: { fn: addressAll } },
    ];
    const r = await run(new FakeDriver(script(Object.fromEntries(MODELS.map(plan)))));
    expect(r.status).toBe("converged");
    expect(r.gate.passed).toBe(true);
  });

  it("score на границе порога: 0.75 — гейт пройден, чуть ниже — нет", async () => {
    const at = await run(
      new FakeDriver(
        script({ "model-a": same(X, 0.75), "model-b": same(X, 0.75), "model-c": same(Y, 0.5) }),
      ),
    );
    expect(at.status).toBe("majority");
    expect(at.score).toBe(0.75);
    expect(at.gate.passed).toBe(true);
    const below = await run(
      new FakeDriver(
        script({ "model-a": same(X, 0.75), "model-b": same(X, 0.75), "model-c": same(Y, 0.51) }),
      ),
    );
    expect(below.status).toBe("majority");
    expect(below.gate.passed).toBe(false);
  });

  it("незакрытый major против большинства снижает score на 0.1", async () => {
    const majors = critique(ALL7, { severity: "major" });
    const r = await run(
      new FakeDriver(
        script({
          "model-a": { ...same(X), critique: majors },
          "model-b": { ...same(X), critique: majors },
          "model-c": { ...same(X), critique: majors },
        }),
      ),
    );
    // все за X: доля 1.0; каждый критик даёт major каждому чужому → 6 незакрытых major → 0.4
    expect(r.status).toBe("converged");
    expect(r.score).toBeCloseTo(0.4);
    expect(r.gate.passed).toBe(false);
  });

  it("нет кворума в критике — quorum_failed без синтеза", async () => {
    const r = await run(
      new FakeDriver(
        script({
          "model-a": { ...same(X), critique: { error: "timeout" } },
          "model-b": { ...same(X), critique: { error: "timeout" } },
          "model-c": same(X),
        }),
      ),
    );
    expect(r.status).toBe("quorum_failed");
    expect(r.decision).toBe("");
  });

  it("research_first: шаг исследования, его итог — в контексте предложений", async () => {
    const research: FakeReply = {
      value: {
        findings: [{ fact: "таблица payments 2 млрд строк", source: "db/schema.sql:12" }],
        constraints: [],
        options: [],
        unknowns: [],
      },
    };
    const driver = new FakeDriver(
      script(Object.fromEntries(MODELS.map((m) => [m, { ...same(X), research }]))),
    );
    const r = await run(driver, { researchFirst: true });
    expect(r.status).toBe("converged");
    expect(driver.prompts[0]?.round).toBe("research");
    const propose = driver.prompts.find((p) => p.round === "propose")!;
    expect(propose.prompt).toContain("таблица payments 2 млрд строк (db/schema.sql:12)");
  });

  it("research_first без кворума: совет продолжает без исследования, а не обрывается", async () => {
    // research в скрипте по умолчанию — no_answer у всех.
    const driver = new FakeDriver(script(Object.fromEntries(MODELS.map((m) => [m, same(X)]))));
    const r = await run(driver, { researchFirst: true });
    expect(r.status).toBe("converged");
    expect(r.warnings.join("\n")).toMatch(/исследование неполное: ответили 0 из 3/);
    expect(driver.prompts.some((p) => p.round === "critique-1")).toBe(true);
  });

  it("max_rounds 0 запрещён: без раундов совет не обсуждает", async () => {
    await expect(run(new FakeDriver({}), { maxRounds: 0 })).rejects.toThrow(
      /max_rounds: от 1 до 5/,
    );
  });

  it("goal plan требует план в синтезе и пишет его в ADR; goal advice — без ADR", async () => {
    const withPlan: FakeReply = {
      value: {
        ...(synthesis(X) as { value: Record<string, unknown> }).value,
        plan: [
          { step: "Создать партиции", details: "декларативно", files: ["db/migrations/0042.sql"] },
        ],
      },
    };
    const planned = await run(
      new FakeDriver(
        script(Object.fromEntries(MODELS.map((m) => [m, { ...same(X), synth: withPlan }]))),
      ),
      { goal: "plan", writeAdr: true },
    );
    expect(planned.status).toBe("converged");
    expect(readFileSync(join(WS, planned.adr_path!), "utf8")).toMatch(
      /## План работ\n\n1\. \*\*Создать партиции\*\* — декларативно\n {3}Файлы: `db\/migrations\/0042.sql`/,
    );

    // Без плана синтез отклоняется правилами (настоящая модель получит ошибку и исправит ответ;
    // фейк не исправляет) → оба председателя не справились, итог собран из позиций.
    const noPlan = await run(
      new FakeDriver(script(Object.fromEntries(MODELS.map((m) => [m, same(X)])))),
      { goal: "plan" },
    );
    expect(noPlan.warnings).toContain(
      "синтез председателя не удался — итог собран из позиций участников",
    );

    const advice = await deliberate(
      { mode: "consensus", question: "Совет по индексам?", goal: "advice" },
      {
        config,
        driver: new FakeDriver(script(Object.fromEntries(MODELS.map((m) => [m, same(X)])))),
        runId: "20261122-advice",
      },
    );
    expect(advice.adr_path).toBeUndefined();
  });
});

/** Вето ставит только персона с правом вето (по роли в промпте). */
function vetoIfSre({ prompt }: { alias: string; prompt: string }): unknown {
  const labels = /\(метки ([A-Z0-9, ]+)\)/.exec(prompt)?.[1]?.split(", ") ?? [];
  const canVeto = prompt.includes("Твоя роль даёт право вето");
  return {
    reviews: labels.map((label) => ({
      label,
      strengths: [],
      flaws: [
        {
          text: "нет плана отката",
          severity: canVeto ? "critical" : "minor",
          ...(canVeto && { veto: true }),
        },
      ],
      questions: [],
    })),
    ranking: labels,
  };
}

/** Доработка, закрывающая замечания всех критиков (triggered_by каждого). */
function addressAll({ prompt }: { alias: string; prompt: string }): unknown {
  const critics = [...prompt.matchAll(/### Критика от ([A-Z0-9]+)/g)].map((m) => m[1]!);
  return {
    ...(proposal(X) as { value: Record<string, unknown> }).value,
    changes: critics.map((c) => ({
      what: "добавлен план отката",
      why: "замечание",
      triggered_by: c,
    })),
  };
}

describe("прогноз и бюджет", () => {
  it("planRun: состав панели и прогноз вызовов", async () => {
    const fresh = loadConfig(
      fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: mkdtempSync(join(tmpdir(), "council-est-")) }),
    );
    const plan = await planRun({ mode: "consensus", question: "q", panel: 5 }, fresh, "r");
    expect(plan.seats).toHaveLength(5);
    // 5 предложений + 2 итерации × (5 критик + 5 доработок + судья) + синтез и запасной председатель
    expect(plan.estimate.calls).toEqual({ min: 16, max: 29 });
    expect(plan.estimate.basis).toBe("default");
    const vote = await planRun({ mode: "vote", question: "q", options: ["a", "b"] }, config, "r");
    expect(vote.estimate.calls).toEqual({ min: 3, max: 3 });
  });

  it("прогноз выше бюджета — отказ до запуска; подтверждение снимает отказ", async () => {
    const driver = new FakeDriver(script(Object.fromEntries(MODELS.map((m) => [m, same(X)]))));
    const input: DeliberateInput = { mode: "consensus", question: "q", budget: { maxCalls: 5 } };
    await expect(
      deliberate(input, { config, driver, runId: "r1", artifacts: false }),
    ).rejects.toBeInstanceOf(BudgetError);
    expect(driver.prompts).toHaveLength(0);
    // Подтверждение снимает отказ по прогнозу, но лимит остаётся жёстким: после предложений
    // (3 вызова ≥ 5? нет) и критики (6 ≥ 5) — стоп, доработки нет, синтез по имеющемуся.
    const capped = await deliberate(
      { ...input, confirmBudget: true },
      { config, driver, runId: "r2", artifacts: false },
    );
    expect(capped.status).toBe("partial");
    expect(capped.gate.passed).toBe(false);
    expect(capped.decision).not.toBe("");
    expect(capped.warnings.some((w) => w.startsWith("бюджет исчерпан (вызовов 6 из 5)"))).toBe(
      true,
    );
    expect(driver.prompts.some((p) => p.round === "revise-1")).toBe(false);
    expect(driver.prompts.some((p) => p.round === "synthesize")).toBe(true);
  });

  it("превышение бюджета даёт partial с ADR", async () => {
    const driver = new FakeDriver(script(Object.fromEntries(MODELS.map((m) => [m, same(X)]))));
    const r = await deliberate(
      {
        mode: "consensus",
        question: "Бюджетный вопрос",
        budget: { maxCalls: 3 },
        confirmBudget: true,
      },
      { config, driver, runId: "20261122-budget", artifacts: true },
    );
    expect(r.status).toBe("partial");
    expect(r.adr_path).toBeDefined();
    expect(readFileSync(join(WS, r.adr_path!), "utf8")).toMatch(/council: partial/);
    expect(r.report).toMatch(/⚠ бюджет исчерпан \(вызовов 3 из 3\)/);
  });
});
