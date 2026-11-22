import { describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../src/core/config.js";
import { deliberate } from "../src/core/deliberate.js";
import type { CouncilEvent } from "../src/core/events.js";
import {
  critique,
  grouping,
  proposal,
  revision,
  switchTo,
  synthesis,
  times,
} from "./consensus-builders.js";
import { FakeDriver, type FakeReply, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const config = loadConfig(fakeDeps(baseEnv));
const ALL = ["A", "B", "C"];
const QUESTION = "Как партиционировать таблицу платежей?";

interface Seat {
  propose: FakeReply;
  revise: FakeReply[];
  critique?: FakeReply;
  judge?: FakeReply;
  synth?: FakeReply;
}

/** Сценарий на модель; критика по умолчанию — minor ко всем чужим, на каждую итерацию. */
function script(seats: Record<string, Seat>, iterations = 2): FakeScript {
  return Object.fromEntries(
    Object.entries(seats).map(([model, s]) => {
      const rounds: Record<string, FakeReply[]> = {
        propose: [s.propose],
        synthesize: s.synth ? [s.synth] : [],
      };
      for (let i = 1; i <= iterations; i++) {
        rounds[`critique-${String(i)}`] = [s.critique ?? critique(ALL)];
        rounds[`revise-${String(i)}`] = [
          s.revise[i - 1] ?? s.revise[s.revise.length - 1] ?? { error: "no_answer" },
        ];
        rounds[`judge-${String(i)}`] = s.judge ? [s.judge] : [];
      }
      return [model, rounds];
    }),
  );
}

async function run(driver: FakeDriver, cfg: CouncilConfig = config, events: CouncilEvent[] = []) {
  return deliberate(
    { mode: "consensus", question: QUESTION, notes: "PostgreSQL 16, 2 млрд строк" },
    { config: cfg, driver, runId: "20261122-c0ffee", emit: (e) => events.push(e), now: () => 0 },
  );
}

const rounds = (driver: FakeDriver) => [...new Set(driver.prompts.map((p) => p.round))];

describe("deliberate: consensus", () => {
  it("converged: все за одно решение, синтез без особого мнения", async () => {
    const key = "pg-partition-by-month";
    const seat: Seat = { propose: proposal(key), revise: [revision(key)], synth: synthesis(key) };
    const driver = new FakeDriver(script({ "model-a": seat, "model-b": seat, "model-c": seat }));
    const r = await run(driver);

    expect(r.status).toBe("converged");
    expect(r.decision).toBe(`Принять ${key}`);
    expect(r.dissent).toBeUndefined();
    expect(r.score).toBe(1);
    expect(r.gate).toEqual({ threshold: 0.75, passed: true });
    expect(r.open_questions).toEqual(["кто владелец миграции?"]);
    expect(r.votes?.map((v) => v.choice)).toEqual([key, key, key]);
    expect(rounds(driver)).toEqual(["propose", "critique-1", "revise-1", "synthesize"]);
    expect(driver.prompts.filter((p) => p.round === "synthesize")).toHaveLength(1);
    expect(r.report).toMatch(/Статус: converged · score 1\.00 \(гейт 0\.75 ✓\)/);
  });

  it("majority: 2 из 3 с особым мнением; судья подтверждает, что ключи разные", async () => {
    const x = "pg-partition-by-month";
    const y = "shard-by-tenant";
    const judge = grouping([[x], [y]]);
    const majority: Seat = {
      propose: proposal(x, 0.9),
      revise: [revision(x, 0.9)],
      judge,
      synth: synthesis(x, "C: шардирование по тенанту"),
    };
    const minority: Seat = {
      propose: proposal(y, 0.4),
      revise: [revision(y, 0.4)],
      judge,
      synth: synthesis(x, "C: шардирование по тенанту"),
    };
    const driver = new FakeDriver(
      script({ "model-a": majority, "model-b": majority, "model-c": minority }),
    );
    const r = await run(driver);

    expect(r.status).toBe("majority");
    expect(r.dissent).toBe("C: шардирование по тенанту");
    expect(r.score).toBeCloseTo(1.8 / 2.2, 2);
    expect(r.gate.passed).toBe(true);
    expect(rounds(driver)).toEqual(["propose", "critique-1", "revise-1", "judge-1", "synthesize"]);
  });

  it("судья объединяет синонимы в одно решение", async () => {
    const judge = grouping([["partition-by-month", "pg-monthly-partitions"], ["shard-by-tenant"]]);
    const a: Seat = {
      propose: proposal("partition-by-month"),
      revise: [revision("partition-by-month")],
      judge,
      synth: synthesis("partition-by-month", "меньшинство за шардирование"),
    };
    const b: Seat = {
      ...a,
      propose: proposal("pg-monthly-partitions"),
      revise: [revision("pg-monthly-partitions")],
    };
    const c: Seat = {
      ...a,
      propose: proposal("shard-by-tenant", 0.5),
      revise: [revision("shard-by-tenant", 0.5)],
    };
    const r = await run(new FakeDriver(script({ "model-a": a, "model-b": b, "model-c": c })));
    expect(r.status).toBe("majority");
  });

  it("смена позиции с аргументом приводит к сходимости во второй итерации", async () => {
    const x = "partition-by-month";
    const judge = grouping([[x], ["shard-by-tenant"]]);
    const stay: Seat = { propose: proposal(x), revise: [revision(x)], judge, synth: synthesis(x) };
    const convert: Seat = {
      propose: proposal("shard-by-tenant"),
      revise: [revision("shard-by-tenant"), switchTo(x, ALL)],
      judge,
      synth: synthesis(x),
    };
    // Первая итерация: x, x, shard — но уверенность 0.6 < 0.7, большинства нет; вторая — все за x.
    const weak: Seat = {
      ...stay,
      propose: proposal(x, 0.6),
      revise: [revision(x, 0.6), revision(x, 0.6)],
    };
    const driver = new FakeDriver(script({ "model-a": weak, "model-b": weak, "model-c": convert }));
    const r = await run(driver);
    expect(r.status).toBe("converged");
    expect(rounds(driver)).toContain("revise-2");
  });

  it("no_consensus: все остались при своём после max_rounds", async () => {
    const keys = ["partition-by-month", "shard-by-tenant", "archive-cold-data"];
    const judge = grouping(keys.map((k) => [k]));
    const seats = Object.fromEntries(
      ["model-a", "model-b", "model-c"].map((m, i) => {
        const k = keys[i]!;
        return [
          m,
          {
            propose: proposal(k),
            revise: times(2, revision(k)),
            judge,
            synth: synthesis(k, "позиции разошлись"),
          },
        ];
      }),
    );
    const driver = new FakeDriver(script(seats));
    const r = await run(driver);
    expect(r.status).toBe("no_consensus");
    expect(r.gate.passed).toBe(false);
    expect(r.warnings).toContain("консенсус не достигнут — решение за человеком");
    expect(rounds(driver)).toEqual([
      "propose",
      "critique-1",
      "revise-1",
      "judge-1",
      "critique-2",
      "revise-2",
      "judge-2",
      "synthesize",
    ]);
  });

  it("незакрытый critical против большинства не даёт majority", async () => {
    const x = "partition-by-month";
    const y = "shard-by-tenant";
    const judge = grouping([[x], [y]]);
    const blocker: Seat = {
      propose: proposal(y, 0.9),
      revise: times(2, revision(y, 0.9)),
      critique: critique(ALL, { severity: "critical" }),
      judge,
      synth: synthesis(x, "C против"),
    };
    const maj: Seat = {
      propose: proposal(x, 0.9),
      revise: times(2, revision(x, 0.9)),
      judge,
      synth: synthesis(x, "C против"),
    };
    const r = await run(
      new FakeDriver(script({ "model-a": maj, "model-b": maj, "model-c": blocker })),
    );
    expect(r.status).toBe("no_consensus");
  });

  it("деградация: одна модель упала — решение двумя, отмечено в участниках", async () => {
    const key = "partition-by-month";
    const ok: Seat = { propose: proposal(key), revise: [revision(key)], synth: synthesis(key) };
    const driver = new FakeDriver(
      script({
        "model-a": ok,
        "model-b": ok,
        "model-c": { propose: { error: "timeout" }, revise: [] },
      }),
    );
    const scriptC = (driver as unknown as { script: FakeScript }).script["model-c"]!;
    scriptC.propose = [{ error: "timeout" }, { error: "agent_exited" }];
    const r = await run(driver);
    expect(r.status).toBe("converged");
    expect(r.participants.filter((p) => p.state === "failed")).toHaveLength(1);
    expect(r.report).toMatch(/✗ отказ/);
  });

  it("осталась одна модель — partial без критики; никто не ответил — failed", async () => {
    const key = "partition-by-month";
    const one = new FakeDriver(
      script({ "model-a": { propose: proposal(key), revise: [] } }),
      new Set(["model-b", "model-c"]),
    );
    const partial = await run(one);
    expect(partial.status).toBe("partial");
    expect(partial.decision).toBe(`решение ${key}`);
    expect(partial.gate.passed).toBe(false);
    expect(rounds(one)).toEqual(["propose"]);

    const failed = await run(new FakeDriver({}));
    expect(failed.status).toBe("failed");
  });

  it("председатель из конфига получает синтез", async () => {
    const key = "partition-by-month";
    const seat: Seat = { propose: proposal(key), revise: [revision(key)], synth: synthesis(key) };
    const driver = new FakeDriver(script({ "model-a": seat, "model-b": seat, "model-c": seat }));
    await run(driver, { ...config, chair: "model-c" });
    expect(driver.prompts.filter((p) => p.round === "synthesize").map((p) => p.modelId)).toEqual([
      "model-c",
    ]);
  });

  it("промпты: свои предложения не критикуются, имён моделей нет, контекст передан", async () => {
    const key = "partition-by-month";
    const seat: Seat = { propose: proposal(key), revise: [revision(key)], synth: synthesis(key) };
    const driver = new FakeDriver(script({ "model-a": seat, "model-b": seat, "model-c": seat }));
    await run(driver);
    for (const p of driver.prompts) {
      expect(p.prompt).not.toMatch(/model-[abc]/);
      expect(p.prompt).toContain("PostgreSQL 16, 2 млрд строк");
    }
    for (const p of driver.prompts.filter((q) => q.round === "critique-1")) {
      expect(p.prompt).not.toContain(`### Предложение ${p.alias}\n`);
      for (const other of ALL.filter((a) => a !== p.alias))
        expect(p.prompt).toContain(`### Предложение ${other}\n`);
    }
    const roles = driver.prompts
      .filter((p) => p.round === "propose")
      .map((p) => /Твоя роль: ([^—]+)/.exec(p.prompt)?.[1]);
    expect(new Set(roles).size).toBe(3);
  });

  it("события прогресса по раундам", async () => {
    const key = "partition-by-month";
    const seat: Seat = { propose: proposal(key), revise: [revision(key)], synth: synthesis(key) };
    const events: CouncilEvent[] = [];
    await run(
      new FakeDriver(script({ "model-a": seat, "model-b": seat, "model-c": seat })),
      config,
      events,
    );
    const started = events
      .filter((e) => e.type === "round_started")
      .map((e) => (e as { round: string }).round);
    expect(started).toEqual(["propose", "critique-1", "revise-1", "synthesize"]);
  });
});
