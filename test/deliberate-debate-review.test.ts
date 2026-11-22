import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { deliberate, InputError, type DeliberateInput } from "../src/core/deliberate.js";
import { aggregateJudges } from "../src/core/protocols/debate.js";
import type { Judgement, Review } from "../src/core/protocols/debate-schemas.js";
import { mergeFindings } from "../src/core/protocols/review.js";
import { times } from "./consensus-builders.js";
import { FakeDriver, type FakeReply, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps, WS } from "./helpers.js";

const config = loadConfig(fakeDeps(baseEnv));
const MODELS = ["model-a", "model-b", "model-c"];
const OPTIONS = ["REST", "gRPC"];

const turn: FakeReply = {
  value: {
    arguments: [{ claim: "контракты уже в protobuf", evidence: "api/payments.proto:1" }],
    rebuttals: [],
    concessions: ["REST проще отлаживать"],
  },
};
const judge = (winner: "first" | "second" | "tie", confidence = 0.8): FakeReply => ({
  value: {
    scores: [
      { criterion: "корректность", first: 7, second: 8, note: "n" },
      { criterion: "эксплуатация", first: 8, second: 6, note: "n" },
    ],
    winner,
    confidence,
    rationale: `судья за ${winner}`,
    strongest_first: "проще для внешних клиентов",
    strongest_second: "строгие контракты",
    conditions: ["если появятся внешние клиенты"],
  },
});

function debateScript(
  judges: Record<string, FakeReply[]>,
  extra: Record<string, Record<string, FakeReply[]>> = {},
): FakeScript {
  return Object.fromEntries(
    MODELS.map((m) => {
      const rounds: Record<string, FakeReply[]> = {};
      for (const p of [1, 2])
        for (const r of [1, 2]) rounds[`debate-${String(p)}-${String(r)}`] = times(4, turn);
      rounds["judge-1"] = judges[m] ?? times(4, judge("first"));
      rounds["judge-2"] = judges[m] ?? times(4, judge("first"));
      rounds.options = [{ value: { options: ["Монолит", "Микросервисы"], reason: "две школы" } }];
      return [m, { ...rounds, ...extra[m] }];
    }),
  );
}

const run = (driver: FakeDriver, input: Partial<DeliberateInput> = {}) =>
  deliberate(
    { mode: "debate", question: "REST или gRPC для внутреннего API?", options: OPTIONS, ...input },
    { config, driver, runId: "20261122-deb001", artifacts: input.writeAdr === true },
  );

describe("debate", () => {
  it("два участника, судья — победитель с уверенностью; отчёт с баллами и прогонами", async () => {
    const driver = new FakeDriver(debateScript({}));
    const r = await run(driver, { writeAdr: true });
    expect(r.status).toBe("converged");
    expect(r.decision).toBe("REST");
    expect(r.score).toBeCloseTo(1);
    expect(r.gate.passed).toBe(true);
    expect(r.debate?.options).toEqual(OPTIONS);
    expect(r.report).toMatch(/Варианты: 1\) REST · 2\) gRPC/);
    expect(r.report).toMatch(/Баллы: корректность 7\.0\/8\.0 · эксплуатация 8\.0\/6\.0/);
    expect(r.report).toMatch(/Прогоны: [A-C]↔[A-C] → REST \(1\.00\)/);
    const rounds = [...new Set(driver.prompts.map((p) => p.round))];
    expect(rounds).toEqual(["debate-1-1", "debate-1-2", "judge-1"]);
    // Во втором раунде дебатёр видит реплику оппонента.
    const second = driver.prompts.filter((p) => p.round === "debate-1-2");
    expect(second.every((p) => p.prompt.includes("### Раунд 1"))).toBe(true);
    // Судья — модель, которой нет среди дебатёров.
    const debaterModels = new Set(
      driver.prompts.filter((p) => p.round.startsWith("debate-")).map((p) => p.modelId),
    );
    const judgeModel = driver.prompts.find((p) => p.round === "judge-1")!.modelId;
    expect(debaterModels.has(judgeModel)).toBe(false);
    const adr = readFileSync(join(WS, r.adr_path!), "utf8");
    expect(adr).toContain("## Когда пересмотреть\n\n- если появятся внешние клиенты");
    expect(adr).toContain("Баллы судей (первый вариант против второго)");
  });

  it("swap_sides: победитель тот же — converged; сменился вместе со сторонами — tie", async () => {
    const same = await run(new FakeDriver(debateScript({})), { swapSides: true });
    expect(same.status).toBe("converged");
    expect(same.debate?.passes).toHaveLength(2);

    const flipping = Object.fromEntries(MODELS.map((m) => [m, [judge("first")]]));
    const script = debateScript(
      flipping,
      Object.fromEntries(MODELS.map((m) => [m, { "judge-2": [judge("second")] }])),
    );
    const flipped = await run(new FakeDriver(script), { swapSides: true });
    expect(flipped.status).toBe("tie");
    expect(flipped.gate.passed).toBe(false);
    expect(flipped.warnings).toContain(
      "при обмене сторон победитель сменился — исход зависел от роли, а не от вариантов",
    );
  });

  it("без options совет сам выделяет два варианта", async () => {
    const driver = new FakeDriver(debateScript({}));
    const r = await deliberate(
      { mode: "debate", question: "Монолит или микросервисы для платёжного ядра?" },
      { config, driver, runId: "20261122-deb002", artifacts: false },
    );
    expect(driver.prompts[0]?.round).toBe("options");
    expect(r.debate?.options).toEqual(["Монолит", "Микросервисы"]);
    expect(r.decision).toBe("Монолит");
  });

  it("panel 5: трое судей, большинство с весом уверенности; несогласный судья — в особом мнении", async () => {
    // Первый ответивший судья — против (second, 0.6), остальные — за (first, 0.9).
    let calls = 0;
    const judgeFn: FakeReply = {
      fn: () =>
        (judge(calls++ === 0 ? "second" : "first", calls === 1 ? 0.6 : 0.9) as { value: unknown })
          .value,
    };
    const judges = Object.fromEntries(MODELS.map((m) => [m, times(4, judgeFn)]));
    const r = await run(new FakeDriver(debateScript(judges)), { panel: 5 });
    expect(r.votes?.map((v) => v.choice).sort()).toEqual(["REST", "REST", "gRPC"]);
    expect(r.status).toBe("majority");
    expect(r.decision).toBe("REST");
    expect(r.score).toBeCloseTo(1.8 / 2.4);
    expect(r.dissent).toMatch(/Судья против: судья за second/);
  });

  it("сторона не ответила — дебаты остановлены; нет кворума судей — quorum_failed", async () => {
    const silent = debateScript(
      {},
      Object.fromEntries(
        MODELS.map((m) => [m, { "debate-1-1": [{ error: "no_answer" }, { error: "no_answer" }] }]),
      ),
    );
    const stopped = await run(new FakeDriver(silent));
    expect(["failed", "partial"]).toContain(stopped.status);
    const noJudges = debateScript(
      Object.fromEntries(MODELS.map((m) => [m, times(4, { error: "timeout" })])),
    );
    const r = await run(new FakeDriver(noJudges));
    expect(r.status).toBe("quorum_failed");
  });

  it("aggregateJudges: вес по уверенности, равенство — ничья", () => {
    const j = (w: "first" | "second" | "tie", c: number) => ({
      ...(judge(w, c) as { value: Judgement }).value,
      winner: w,
      confidence: c,
    });
    expect(aggregateJudges([j("first", 0.9), j("second", 0.6), j("first", 0.3)])).toMatchObject({
      winner: 0,
    });
    expect(aggregateJudges([j("first", 0.5), j("second", 0.5)]).winner).toBeUndefined();
    expect(aggregateJudges([j("tie", 0.9)]).winner).toBeUndefined();
  });

  it("debate: ровно два варианта", async () => {
    await expect(run(new FakeDriver({}), { options: ["a", "b", "c"] })).rejects.toBeInstanceOf(
      InputError,
    );
    await expect(
      deliberate(
        { mode: "consensus", question: "q", swapSides: true },
        { config, driver: new FakeDriver({}), runId: "r" },
      ),
    ).rejects.toThrow(/swap_sides: только для debate/);
  });
});

const DIFF = `diff --git a/src/api/payments.ts b/src/api/payments.ts
+app.get("/payments", (req, res) => db.query("SELECT * FROM payments WHERE id = " + req.query.id));`;

const review = (verdict: "pass" | "fail", findings: Review["findings"] = []): FakeReply => ({
  value: { verdict, summary: `итог: ${verdict}`, findings },
});
const sqli = {
  severity: "critical" as const,
  title: "SQL-инъекция в /payments",
  file: "src/api/payments.ts",
  line: 1,
  detail: "конкатенация req.query.id в SQL",
  blocker: true,
};

const runReview = (byModel: Record<string, FakeReply>, input: Partial<DeliberateInput> = {}) =>
  deliberate(
    { mode: "review", question: "Ревью эндпоинта платежей", diff: DIFF, ...input },
    {
      config,
      driver: new FakeDriver(
        Object.fromEntries(
          MODELS.map((m) => [m, { review: times(3, byModel[m] ?? review("pass")) }]),
        ),
      ),
      runId: "20261122-rev001",
      artifacts: false,
    },
  );

describe("review", () => {
  it("все pass без блокеров — GO; red-team и без ADR по умолчанию", async () => {
    const r = await runReview({});
    expect(r.status).toBe("converged");
    expect(r.review).toMatchObject({ verdict: "go", score: 1, criticals: 0 });
    expect(r.gate.passed).toBe(true);
    expect(r.decision).toMatch(/^GO/);
    expect(r.participants.map((p) => p.personas[0])).toEqual(
      expect.arrayContaining(["red team", "инсайдер"]),
    );
    expect(r.adr_path).toBeUndefined();
    expect(r.report).toMatch(/Вердикт: GO · pass 3\/3 · critical 0/);
  });

  it("заложенная уязвимость: critical — NO-GO, даже если большинство pass", async () => {
    const r = await runReview({
      "model-b": review("fail", [sqli]),
      "model-c": review("pass", [{ ...sqli, severity: "major", blocker: false }]),
    });
    expect(r.review?.verdict).toBe("no-go");
    expect(r.gate.passed).toBe(false);
    expect(r.decision).toBe("NO-GO: SQL-инъекция в /payments");
    expect(r.review?.findings[0]).toMatchObject({ severity: "critical", blocker: true });
    expect(r.review?.findings[0]?.by).toHaveLength(2);
    expect(r.report).toMatch(
      /- \[critical\] src\/api\/payments\.ts:1 SQL-инъекция в \/payments \([A-C], [A-C]\)/,
    );
  });

  it("доля pass ниже порога — NO-GO", async () => {
    const r = await runReview({ "model-a": review("fail"), "model-b": review("fail") });
    expect(r.review?.verdict).toBe("no-go");
    expect(r.status).toBe("majority");
  });

  it("mergeFindings объединяет одинаковые находки и берёт максимальную серьёзность", () => {
    const merged = mergeFindings(
      new Map([
        [
          "A",
          {
            verdict: "fail",
            summary: "s",
            findings: [{ ...sqli, severity: "major", blocker: false }],
          },
        ],
        [
          "B",
          {
            verdict: "fail",
            summary: "s",
            findings: [{ ...sqli, title: "SQL-ИНЪЕКЦИЯ в /payments " }],
          },
        ],
        [
          "C",
          {
            verdict: "pass",
            summary: "s",
            findings: [{ ...sqli, title: "другое", severity: "minor", blocker: false }],
          },
        ],
      ]),
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ severity: "critical", blocker: true, by: ["A", "B"] });
  });

  it("review без диффа — ошибка входа", async () => {
    await expect(runReview({}, { diff: "" })).rejects.toThrow(/для review нужен дифф/);
  });
});
