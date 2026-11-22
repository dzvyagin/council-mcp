import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { deliberate, InputError } from "../src/core/deliberate.js";
import type { CouncilEvent } from "../src/core/events.js";
import { FakeDriver, vote } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const config = loadConfig(fakeDeps(baseEnv));
const OPTIONS = ["REST", "gRPC"];

function run(driver: FakeDriver, events: CouncilEvent[] = []) {
  return deliberate(
    { mode: "vote", question: "REST или gRPC для внутреннего API?", options: OPTIONS },
    { config, driver, runId: "20261122-abc123", emit: (e) => events.push(e), now: () => 0 },
  );
}

describe("deliberate: vote", () => {
  it("даёт majority с особым мнением и отчётом без имён моделей", async () => {
    const driver = new FakeDriver({
      "model-a": { vote: [vote("gRPC", 0.9, "контракты protobuf уже есть")] },
      "model-b": { vote: [vote("gRPC", 0.7)] },
      "model-c": { vote: [vote("REST", 0.6, "внешние клиенты")] },
    });
    const events: CouncilEvent[] = [];
    const r = await run(driver, events);

    expect(r.status).toBe("majority");
    expect(r.decision).toBe("gRPC");
    expect(r.score).toBeCloseTo(0.73, 2);
    expect(r.gate).toEqual({ threshold: 0.7, passed: true });
    expect(r.dissent).toMatch(/REST — внешние клиенты/);
    expect(r.votes).toHaveLength(3);
    expect(r.usage).toMatchObject({ calls: 3, prompt_tokens: 300, completion_tokens: 60 });
    expect(r.report).toMatch(/^🏛 Council · vote · участников 3 {4}run 20261122-abc123/);
    for (const text of [r.report, JSON.stringify(r)]) {
      expect(text).not.toMatch(/model-[abc]/);
    }
    expect(driver.closed).toBe(3);
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "round_started",
      "participant_done",
      "participant_done",
      "participant_done",
      "round_finished",
      "run_finished",
    ]);
  });

  it("имена моделей не попадают в промпты; варианты перемешиваются воспроизводимо", async () => {
    const script = () => ({
      "model-a": { vote: [vote("gRPC", 0.9)] },
      "model-b": { vote: [vote("gRPC", 0.7)] },
      "model-c": { vote: [vote("REST", 0.6)] },
    });
    const d1 = new FakeDriver(script());
    const d2 = new FakeDriver(script());
    await run(d1);
    await run(d2);
    for (const p of d1.prompts) {
      expect(p.prompt).not.toMatch(/model-[abc]/);
      expect(p.prompt).toContain("submit_vote");
    }
    const strip = (s: string) => s.replace(/[0-9a-f]{12}/g, "NONCE");
    expect(d1.prompts.map((p) => [p.alias, strip(p.prompt)])).toEqual(
      d2.prompts.map((p) => [p.alias, strip(p.prompt)]),
    );
  });

  it("ретраит сбой, отмечает деградацию и продолжает без упавшей модели", async () => {
    const driver = new FakeDriver({
      "model-a": { vote: [{ error: "timeout" }, vote("gRPC", 0.8)] },
      "model-b": { vote: [vote("gRPC", 0.8)] },
      "model-c": { vote: [{ error: "agent_exited" }, { error: "agent_exited" }] },
    });
    const events: CouncilEvent[] = [];
    const r = await run(driver, events);
    expect(r.status).toBe("converged");
    const states = Object.fromEntries(r.participants.map((p) => [p.state, p.note]));
    expect(Object.keys(states).sort()).toEqual(["degraded", "failed", "ok"]);
    expect(events.filter((e) => e.type === "participant_retry")).toHaveLength(2);
    expect(events.filter((e) => e.type === "participant_failed")).toHaveLength(1);
    expect(r.report).toMatch(/⚠ деградация/);
    expect(r.report).toMatch(/✗ отказ \(agent_exited\)/);
  });

  it("осталась одна модель — partial, гейт не пройден", async () => {
    const driver = new FakeDriver(
      { "model-a": { vote: [vote("gRPC", 0.9)] } },
      new Set(["model-b", "model-c"]),
    );
    const r = await run(driver);
    expect(r.status).toBe("partial");
    expect(r.gate.passed).toBe(false);
    expect(r.warnings).toContain("ответила только одна модель: решение не проходит гейт");
  });

  it("никто не ответил — failed", async () => {
    const r = await run(new FakeDriver({}));
    expect(r.status).toBe("failed");
    expect(r.decision).toBe("");
  });

  it("tie рекомендует consensus", async () => {
    const driver = new FakeDriver({
      "model-a": { vote: [vote("gRPC", 0.9)] },
      "model-b": { vote: [vote("REST", 0.9)] },
      "model-c": { vote: [{ error: "no_answer" }, { error: "no_answer" }] },
    });
    const r = await run(driver);
    expect(r.status).toBe("tie");
    expect(r.warnings).toContain("голоса разделились — запустите consensus");
  });

  it("проверяет вход", async () => {
    const driver = new FakeDriver({});
    const bad = [
      { mode: "vote" as const, question: "  " },
      { mode: "consensus" as const, question: "q" },
      { mode: "vote" as const, question: "q", options: ["a"] },
      { mode: "vote" as const, question: "q", options: ["a", "a"] },
    ];
    for (const input of bad) {
      await expect(deliberate(input, { config, driver, runId: "r" })).rejects.toBeInstanceOf(
        InputError,
      );
    }
  });
});
