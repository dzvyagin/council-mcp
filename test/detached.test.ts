import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cancelRequested,
  detachedSnapshot,
  detachedWait,
  requestCancel,
  writeJobState,
} from "../src/core/detached.js";

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "council-jobs-")));

describe("запуски в рабочем процессе (файл состояния)", () => {
  it("снимок из файла; running с мёртвым процессом — failed", () => {
    const d = dir();
    writeJobState(d, { runId: "r1", status: "running", progress: "p", pid: 999_999, updatedAt: 1 });
    expect(detachedSnapshot(d, "r1", () => true)).toMatchObject({
      status: "running",
      progress: "p",
    });
    expect(detachedSnapshot(d, "r1", () => false)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/рабочий процесс совета завершился без итога/) as string,
    });
    expect(detachedSnapshot(d, "нет")).toBeUndefined();
    expect(detachedSnapshot(d, "../etc")).toBeUndefined();
  });

  it("ожидание: возвращает итог, как только рабочий процесс его записал; прогресс — по изменениям", async () => {
    const d = dir();
    writeJobState(d, {
      runId: "r2",
      status: "running",
      progress: "раунд 1",
      pid: process.pid,
      updatedAt: 1,
    });
    setTimeout(() => {
      writeJobState(d, {
        runId: "r2",
        status: "running",
        progress: "раунд 2",
        pid: process.pid,
        updatedAt: 2,
      });
    }, 60);
    setTimeout(() => {
      writeJobState(d, {
        runId: "r2",
        status: "done",
        progress: "готово",
        pid: process.pid,
        result: { ok: true },
        updatedAt: 3,
      });
    }, 150);
    const seen: string[] = [];
    const s = await detachedWait<{ ok: boolean }>(d, "r2", 5_000, {
      pollMs: 20,
      onProgress: (p) => seen.push(p),
    });
    expect(s).toMatchObject({ status: "done", result: { ok: true } });
    expect(seen).toEqual(["раунд 1", "раунд 2", "готово"]);
  });

  it("ожидание не дольше waitMs: снимок running", async () => {
    const d = dir();
    writeJobState(d, {
      runId: "r3",
      status: "running",
      progress: "…",
      pid: process.pid,
      updatedAt: 1,
    });
    const started = Date.now();
    const s = await detachedWait(d, "r3", 120, { pollMs: 20 });
    expect(s?.status).toBe("running");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("отмена — файл-флаг, только для идущего запуска", () => {
    const d = dir();
    writeJobState(d, {
      runId: "r4",
      status: "running",
      progress: "",
      pid: process.pid,
      updatedAt: 1,
    });
    expect(cancelRequested(d, "r4")).toBe(false);
    expect(requestCancel(d, "r4")).toBe(true);
    expect(cancelRequested(d, "r4")).toBe(true);
    writeJobState(d, { runId: "r5", status: "done", progress: "", updatedAt: 1 });
    expect(requestCancel(d, "r5")).toBe(false);
  });
});
