import { describe, expect, it } from "vitest";

import { defaultRunId, JobRunner } from "../src/core/jobs.js";

describe("JobRunner", () => {
  it("возвращает снимок running, затем итог", async () => {
    let release!: (v: string) => void;
    const runner = new JobRunner<string>({ newRunId: () => "r1" });
    const id = runner.start(async ({ emit, runId }) => {
      emit({ type: "run_started", runId, mode: "vote", aliases: ["A", "B"] });
      emit({ type: "round_started", round: "vote", aliases: ["A", "B"] });
      emit({ type: "participant_done", round: "vote", alias: "A", durationMs: 4000 });
      return new Promise<string>((r) => (release = r));
    });
    const early = await runner.wait(id, 10);
    expect(early?.status).toBe("running");
    expect(early?.progress).toMatch(/🟥 A ✓ 4 с {3}🟨 B …/);
    release("ok");
    const done = await runner.wait(id, 1000);
    expect(done).toMatchObject({ status: "done", result: "ok" });
  });

  it("отмена передаёт сигнал задаче", async () => {
    const runner = new JobRunner<string>();
    const id = runner.start(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("стоп"));
          });
        }),
    );
    expect(runner.cancel(id)).toBe(true);
    expect((await runner.wait(id, 1000))?.status).toBe("cancelled");
    expect(runner.cancel(id)).toBe(false);
  });

  it("ошибка задачи — failed с сообщением; неизвестный run — undefined", async () => {
    const runner = new JobRunner<string>();
    const id = runner.start(() => Promise.reject(new Error("сломалось")));
    expect(await runner.wait(id, 1000)).toMatchObject({ status: "failed", error: "сломалось" });
    expect(await runner.wait("nope", 10)).toBeUndefined();
  });

  it("run_id вида YYYYMMDD-xxxxxx", () => {
    expect(defaultRunId(new Date("2026-11-22T10:00:00Z"))).toMatch(/^20261122-[0-9a-f]{6}$/);
  });
});
