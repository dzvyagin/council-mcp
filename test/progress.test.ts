import { describe, expect, it } from "vitest";

import { ProgressTracker } from "../src/core/output/progress.js";

describe("прогресс", () => {
  it("показывает, что участник работает: число действий и последнее", () => {
    let t = 0;
    const p = new ProgressTracker(() => t, "r1");
    p.apply({ type: "run_started", runId: "r1", mode: "consensus", aliases: ["A", "B"] });
    p.apply({ type: "round_started", round: "research", aliases: ["A", "B"] });
    t = 65_000;
    p.apply({
      type: "participant_activity",
      round: "research",
      alias: "A",
      title: "read src/payments/service.ts",
    });
    p.apply({
      type: "participant_activity",
      round: "research",
      alias: "A",
      title: "grep insurance",
    });
    const text = p.render();
    expect(text).toContain("A … 1 мин 05 с, действий 2 (grep insurance)");
    expect(text).toMatch(/B … 1 мин 05 с(\s|$)/);
  });
});

describe("причина отказа участника", () => {
  it("вид и первая строка сообщения, коротко", async () => {
    const { errorReason } = await import("../src/core/engine.js");
    expect(errorReason("agent_error", '400 Bad Request\n{"error":"context_length_exceeded"}')).toBe(
      'agent_error: 400 Bad Request {"error":"context_length_exceeded"}',
    );
    expect(errorReason("timeout", "")).toBe("timeout");
    expect(errorReason("agent_error", "x".repeat(300)).length).toBeLessThan(170);
  });
});
