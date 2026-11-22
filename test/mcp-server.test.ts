import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CouncilConfig } from "../src/core/config.js";
import { createLogger } from "../src/mcp/logger.js";
import { CouncilRuntime } from "../src/mcp/runtime.js";
import { serveHttp } from "../src/mcp/serve.js";
import { critique, proposal, revision, synthesis } from "./consensus-builders.js";
import { FakeDriver, vote, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const logger = createLogger("silent");
const KEY = "pg-partition-by-month";
const ALL = ["A", "B", "C"];

const consensus = (): FakeScript => {
  const seat = () => ({
    propose: [proposal(KEY)],
    "critique-1": [critique(ALL)],
    "revise-1": [revision(KEY)],
    synthesize: [synthesis(KEY)],
  });
  return { "model-a": seat(), "model-b": seat(), "model-c": seat() };
};

interface Rpc {
  status: number;
  messages: Record<string, unknown>[];
  result: Record<string, unknown>;
}

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function start(
  opts: {
    env?: Record<string, string | undefined>;
    script?: () => FakeScript;
    delayMs?: number;
    token?: string;
  } = {},
) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "council-mcp-")));
  const env = opts.env ?? { ...baseEnv, COUNCIL_WORKSPACE: ws };
  const drivers: FakeDriver[] = [];
  const runtime = new CouncilRuntime({
    configDeps: () => fakeDeps(env),
    makeDriver: (_c: CouncilConfig) => {
      const d = new FakeDriver((opts.script ?? consensus)(), new Set(), opts.delayMs ?? 0);
      drivers.push(d);
      return d;
    },
    logger,
  });
  const served = await serveHttp(runtime, {
    host: "127.0.0.1",
    port: 0,
    ...(opts.token && { token: opts.token }),
  });
  closers.push(served.close);
  let id = 0;
  const rpc = async (
    method: string,
    params?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Rpc> => {
    const res = await fetch(served.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method,
        ...(params !== undefined && { params }),
      }),
    });
    const body = await res.text();
    const messages = body.startsWith("{")
      ? [JSON.parse(body) as Record<string, unknown>]
      : [...body.matchAll(/^data: (.*)$/gm)].map(
          (m) => JSON.parse(m[1]!) as Record<string, unknown>,
        );
    const final = messages.find((m) => "result" in m || "error" in m);
    return {
      status: res.status,
      messages,
      result: (final?.result ?? final?.error ?? {}) as Record<string, unknown>,
    };
  };
  const call = async (
    name: string,
    args: Record<string, unknown>,
    headers?: Record<string, string>,
  ) => {
    const r = await rpc("tools/call", { name, arguments: args }, headers);
    const content = r.result.content as { text: string }[] | undefined;
    return {
      ...r,
      text: content?.map((c) => c.text).join("\n") ?? "",
      structured: r.result.structuredContent as Record<string, unknown> | undefined,
    };
  };
  return { ws, rpc, call, runtime, drivers, url: served.url };
}

describe("MCP-сервер council", () => {
  it("initialize: инструкции; tools и prompts на месте", async () => {
    const s = await start();
    const init = await s.rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(String(init.result.instructions)).toMatch(/council_deliberate/);
    const tools = (await s.rpc("tools/list")).result.tools as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "council_cancel",
      "council_deliberate",
      "council_doctor",
      "council_estimate",
      "council_get_run",
      "council_info",
      "council_route",
      "council_usage",
      "council_wait",
      "council_workflow",
    ]);
    const prompts = (await s.rpc("prompts/list")).result.prompts as { name: string }[];
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "costs",
      "council",
      "debate",
      "embrace",
      "review",
      "setup",
      "vote",
    ]);
    const got = await s.rpc("prompts/get", {
      name: "council",
      arguments: { request: "Как партиционировать?" },
    });
    expect(JSON.stringify(got.result)).toContain("Вопрос: Как партиционировать?");
  });

  it("council_deliberate: отчёт как недоверенные данные, structuredContent, ADR в проекте", async () => {
    const s = await start();
    const r = await s.call("council_deliberate", {
      question: "Как партиционировать платежи?",
      wait_s: 30,
    });
    expect(r.result.isError).toBeUndefined();
    expect(r.text).toMatch(
      /^<council-output trust="untrusted" run_id="\d{8}-[0-9a-f]{6}">\n🏛 Council · consensus/,
    );
    expect(r.text).toMatch(/<\/council-output>\n\nПокажи пользователю отчёт выше как есть/);
    expect(r.structured).toMatchObject({ status: "converged", mode: "consensus" });
    const adr = r.structured?.adr_path as string;
    expect(existsSync(join(s.ws, adr))).toBe(true);
    expect(JSON.stringify(r.result)).not.toMatch(/model-[abc]/);
  });

  it("не успел за wait_s — прогресс и run_id; council_wait доводит до итога", async () => {
    const s = await start({ delayMs: 150 });
    const first = await s.call("council_deliberate", {
      question: "Как партиционировать?",
      wait_s: 0,
    });
    expect(first.structured).toMatchObject({ status: "running" });
    expect(first.text).toMatch(/🏛 Council · (consensus|подготовка запуска)/);
    expect(first.text).toMatch(/вызови council_wait с run_id="/);
    const runId = first.structured?.run_id as string;
    let r = await s.call("council_wait", { run_id: runId, wait_s: 30 });
    while (r.structured?.status === "running")
      r = await s.call("council_wait", { run_id: runId, wait_s: 30 });
    expect(r.structured).toMatchObject({ status: "converged", run_id: runId });
  });

  it("progress notifications приходят, если клиент передал progressToken", async () => {
    const s = await start({ delayMs: 20 });
    const r = await s.rpc("tools/call", {
      name: "council_deliberate",
      arguments: { question: "Как партиционировать?", wait_s: 30 },
      _meta: { progressToken: "p1" },
    });
    const progress = r.messages.filter((m) => m.method === "notifications/progress");
    expect(progress.length).toBeGreaterThan(3);
    expect(JSON.stringify(progress[0])).toContain('"progressToken":"p1"');
  });

  it("council_get_run после перезапуска сервера читает итог из транскрипта", async () => {
    const s = await start();
    const r = await s.call("council_deliberate", { question: "Как партиционировать?", wait_s: 30 });
    const runId = r.structured?.run_id as string;
    const fresh = new CouncilRuntime({
      configDeps: () => fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: s.ws }),
      makeDriver: () => new FakeDriver({}),
      logger,
    });
    const config = fresh.config();
    expect(config.ok).toBe(true);
    const past = await fresh.getRun(runId, (config as { config: CouncilConfig }).config);
    expect(past?.result?.status).toBe("converged");
    expect(past?.result?.report).toMatch(/🏛 Council/);
    expect((await s.call("council_get_run", { run_id: "nope" })).result.isError).toBe(true);
  });

  it("dry_run и council_estimate не вызывают моделей; бюджет — ошибка с прогнозом", async () => {
    const s = await start();
    const dry = await s.call("council_deliberate", { question: "q", panel: 5, dry_run: true });
    expect(dry.text).toMatch(/dry run/);
    expect(dry.structured).toMatchObject({ dry_run: true });
    const est = await s.call("council_estimate", {
      question: "q",
      mode: "vote",
      options: ["a", "b"],
    });
    expect(est.text).toMatch(/^Прогноз: 3 вызова/);
    expect(s.drivers).toHaveLength(0);
    const over = await s.call("council_deliberate", { question: "q", budget: { max_calls: 2 } });
    expect(over.result.isError).toBe(true);
    expect(over.text).toMatch(/прогноз превышает бюджет.*confirm_budget/s);
    expect(over.structured).toMatchObject({ error: "over_budget" });
  });

  it("ошибки входа и конфига — понятный текст, без stacktrace", async () => {
    const noEnv = await start({ env: {} });
    const r = await noEnv.call("council_deliberate", { question: "q" });
    expect(r.result.isError).toBe(true);
    expect(r.text).toMatch(/COUNCIL_BASE_URL: не задана/);
    expect(r.text).not.toMatch(/\bat .+:\d+:\d+/);
    const s = await start();
    const bad = await s.call("council_deliberate", { question: "q", mode: "review" });
    expect(bad.text).toMatch(/^Ошибка входа: context\.diff: для review нужен дифф/);
  });

  it("council_cancel останавливает запуск", async () => {
    const s = await start({ delayMs: 300 });
    const first = await s.call("council_deliberate", { question: "q", wait_s: 0 });
    const runId = first.structured?.run_id as string;
    expect((await s.call("council_cancel", { run_id: runId })).text).toMatch(/отменяется/);
    let r = await s.call("council_wait", { run_id: runId, wait_s: 30 });
    while (r.structured?.status === "running")
      r = await s.call("council_wait", { run_id: runId, wait_s: 30 });
    expect(["partial", "failed", "cancelled"]).toContain(r.structured?.status);
  });

  it("council_info без секретов; vote работает", async () => {
    const s = await start({
      script: () => ({
        "model-a": { vote: [vote("gRPC", 0.9)] },
        "model-b": { vote: [vote("gRPC", 0.8)] },
        "model-c": { vote: [vote("REST", 0.5)] },
      }),
    });
    const info = await s.call("council_info", {});
    expect(info.text).not.toContain(baseEnv.COUNCIL_API_KEY);
    expect(info.text).toContain('"apiKey": "***"');
    const v = await s.call("council_deliberate", {
      question: "REST или gRPC?",
      mode: "vote",
      options: ["REST", "gRPC"],
      wait_s: 30,
    });
    expect(v.structured).toMatchObject({ status: "majority", decision: "gRPC" });
  });

  it("council_route, council_usage и переопределение состава моделей в council_info", async () => {
    const s = await start();
    const r = await s.call("council_route", { request: "REST или gRPC для внутреннего API?" });
    expect(r.text).toMatch(/^Команда: \/council-debate \(high\)/);
    expect(r.structured).toMatchObject({
      command: "council-debate",
      args: { options: ["REST", "gRPC"] },
    });
    expect((await s.call("council_route", { request: "Поправь опечатку" })).text).toMatch(
      /^Совет не нужен/,
    );
    expect((await s.call("council_usage", {})).text).toBe("Запусков с учётом расхода пока нет.");

    type Info = { config: { models: { id: string }[] } };
    const set = await s.call("council_info", { models: ["model-a", "model-x"] });
    expect((JSON.parse(set.text) as Info).config.models.map((m) => m.id)).toEqual([
      "model-a",
      "model-x",
    ]);
    expect((await s.call("council_info", { models: ["only-one"] })).result.isError).toBe(true);
    const reset = await s.call("council_info", { reset: true });
    expect((JSON.parse(reset.text) as Info).config.models).toHaveLength(3);
  });

  it("HTTP: токен обязателен вне loopback и проверяется", async () => {
    const runtime = new CouncilRuntime({
      configDeps: () => fakeDeps(baseEnv),
      makeDriver: () => new FakeDriver({}),
      logger,
    });
    await expect(serveHttp(runtime, { host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /COUNCIL_HTTP_TOKEN/,
    );
    const s = await start({ token: "s3cret-token" });
    expect((await s.rpc("tools/list")).status).toBe(401);
    expect(
      (await s.rpc("tools/list", undefined, { authorization: "Bearer s3cret-token" })).status,
    ).toBe(200);
  });
});
