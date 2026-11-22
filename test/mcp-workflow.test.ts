import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../src/mcp/logger.js";
import { CouncilRuntime } from "../src/mcp/runtime.js";
import { serveHttp } from "../src/mcp/serve.js";
import { critique, proposal, revision, synthesis, times } from "./consensus-builders.js";
import { FakeDriver, type FakeReply, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps, gitRepo } from "./helpers.js";

const logger = createLogger("silent");
const KEY = "partition-by-month";
const ALL = ["A", "B", "C"];
const research: FakeReply = {
  value: {
    findings: [{ fact: "2 млрд строк", source: "db/schema.sql:3" }],
    constraints: [],
    options: [{ key: KEY, summary: "по месяцам" }],
    unknowns: [],
  },
};
const planSynth: FakeReply = {
  value: {
    ...(synthesis(KEY) as { value: Record<string, unknown> }).value,
    plan: [{ step: "Миграция", details: "партиции", files: ["db/migrations/0042.sql"] }],
  },
};
const review: FakeReply = { value: { verdict: "pass", summary: "ок", findings: [] } };
const script = (): FakeScript =>
  Object.fromEntries(
    ["model-a", "model-b", "model-c"].map((m) => [
      m,
      {
        discover: times(3, research),
        propose: times(3, proposal(KEY)),
        "critique-1": times(3, critique(ALL)),
        "revise-1": times(3, revision(KEY)),
        synthesize: times(3, planSynth),
        review: times(6, review),
      },
    ]),
  );

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function server(ws: string) {
  const runtime = new CouncilRuntime({
    configDeps: () => fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: ws }),
    makeDriver: () => new FakeDriver(script()),
    logger,
  });
  const served = await serveHttp(runtime, { host: "127.0.0.1", port: 0 });
  closers.push(served.close);
  let id = 0;
  return async (args: Record<string, unknown>) => {
    const res = await fetch(served.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name: "council_workflow", arguments: args },
      }),
    });
    const body = await res.text();
    const msg = JSON.parse(
      body.startsWith("{") ? body : (/^data: (.*)$/m.exec(body)?.[1] ?? "{}"),
    ) as {
      result: {
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
    };
    return {
      text: msg.result.content.map((c) => c.text).join("\n"),
      structured: msg.result.structuredContent,
      isError: msg.result.isError,
    };
  };
}

describe("MCP: council_workflow (Double Diamond)", () => {
  it("start → advance по фазам; develop требует дифф; status восстанавливается после перезапуска сервера", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "council-mwf-")));
    gitRepo(ws);
    const call = await server(ws);

    const started = await call({
      action: "start",
      task: "Партиционирование платежей",
      autonomy: "supervised",
    });
    expect(started.text).toMatch(/^Процесс wf-\d{8}-[0-9a-f]+ создан/);
    const id = started.structured?.id as string;

    const discover = await call({ action: "advance", workflow_id: id, wait_s: 30 });
    expect(discover.text).toMatch(/Double Diamond wf-.* · фаза discover: гейт ✓ кворум/);
    expect(discover.text).toMatch(/Дальше: define · ждёт подтверждения пользователя/);

    const define = await call({ action: "advance", wait_s: 30 });
    expect(define.structured).toMatchObject({
      workflow: { phase: "define", gate: { passed: true }, current_phase: "develop" },
    });
    expect(define.structured?.worktree_path).toMatch(/^\.council\/worktrees\//);

    const noDiff = await call({ action: "advance" });
    expect(noDiff.isError).toBe(true);
    expect(noDiff.text).toMatch(/для develop нужен дифф/);

    // «Перезапуск»: новый сервер с тем же проектом видит фазу и гейты из .council.
    const restarted = await server(ws);
    const status = await restarted({ action: "status" });
    expect(status.text).toContain(`- Процесс: \`${id}\` — Партиционирование платежей`);
    expect(status.text).toContain("- Фаза: develop (3/4) · статус: ready · autonomy: supervised");
    expect(status.text).toMatch(/✓ Define — решение и план — converged, score 1\.00 ≥ 0\.75/);
    expect(readFileSync(join(ws, ".council/STATE.md"), "utf8")).toContain("Фаза: develop (3/4)");

    const develop = await restarted({
      action: "advance",
      phase_input: { diff: "+partition" },
      wait_s: 30,
    });
    expect(develop.structured).toMatchObject({
      workflow: { phase: "develop", gate: { passed: true } },
    });
    const deliver = await restarted({
      action: "advance",
      phase_input: { diff: "+partition" },
      wait_s: 30,
    });
    expect(deliver.structured).toMatchObject({ workflow: { phase: "deliver", next: "done" } });
    expect((await restarted({ action: "status" })).text).toContain("Фаза: завершён · статус: done");
  });
});
