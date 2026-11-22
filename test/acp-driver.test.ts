import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../src/core/config.js";
import type { Participant } from "../src/core/participant.js";
import { voteTool } from "../src/core/protocols/vote.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { customProfile } from "../src/drivers/acp/profiles.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
const TSX = import.meta.resolve("tsx/esm");
const tool = voteTool(["a", "b"]);

let workspace: string;
let base: CouncilConfig;
let opened: Participant[] = [];
let drivers: AcpDriver[] = [];

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "council-test-"));
  base = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: workspace }));
  process.env.FAKE_SECRET_SHOULD_NOT_LEAK = "leak";
});
afterEach(async () => {
  await Promise.all(opened.map((p) => p.close()));
  await Promise.all(drivers.map((d) => d.dispose()));
  opened = [];
  drivers = [];
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.FAKE_SECRET_SHOULD_NOT_LEAK;
});

async function participant(behavior: string, extra: Record<string, string> = {}) {
  const logFile = join(workspace, `log-${behavior}-${String(Date.now())}.jsonl`);
  const config: CouncilConfig = {
    ...base,
    participant: {
      ...base.participant,
      env: { FAKE_BEHAVIOR: behavior, FAKE_LOG: logFile, ...extra },
    },
  };
  const driver = new AcpDriver(config, {
    profile: customProfile([process.execPath, "--import", TSX, FIXTURE]),
    settleMs: 500,
    startupMs: 20_000,
  });
  drivers.push(driver);
  const p = await driver.open({ alias: "A", model: config.models[0]!, tools: [tool] });
  opened.push(p);
  const events = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { p, events };
}

const ask = (p: Participant, timeoutS = 20, signal?: AbortSignal) =>
  p.ask({ round: "vote", prompt: "Проголосуй", tool, timeoutS, ...(signal && { signal }) });

describe("AcpDriver с фейковым ACP-агентом", () => {
  it("сдаёт ответ через loopback MCP, считает токены и не передаёт лишний env", async () => {
    const { p, events } = await participant("answer");
    const r = await ask(p);
    expect(r).toMatchObject({ ok: true, value: { choice: "a", confidence: 0.8, rationale: "r" } });
    expect(r.usage).toEqual({ calls: 1, inputTokens: 1000, outputTokens: 50 });
    expect(r.transcript).toContain("изучил проект");

    const log = events();
    const session = log.find((e) => e.event === "session/new")!;
    expect(session.cwd).toBe(workspace);
    const servers = session.mcpServers as { type: string; url: string; headers: unknown[] }[];
    expect(servers[0]).toMatchObject({ type: "http", name: "council" });
    expect(servers[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(session.env).toMatchObject({ model: "model-a" });
    expect((session.env as Record<string, unknown>).leaked).toBeUndefined();
    const caps = JSON.stringify(log.find((e) => e.event === "initialize")!.clientCapabilities);
    expect(caps).not.toMatch(/"(readTextFile|writeTextFile|terminal)":true/);
    expect(log).toContainEqual({ event: "set_config_option", configId: "model", value: "model-a" });
  });

  it("сессия переиспользуется между раундами", async () => {
    const { p, events } = await participant("answer");
    expect((await ask(p)).ok).toBe(true);
    expect((await ask(p)).ok).toBe(true);
    expect(events().filter((e) => e.event === "session/new")).toHaveLength(1);
  });

  it("невалидный ответ отклоняется схемой, модель исправляется", async () => {
    const { p, events } = await participant("invalid_then_answer");
    expect((await ask(p)).ok).toBe(true);
    expect(JSON.stringify(events().find((e) => e.event === "invalid"))).toMatch(/isError|error/);
  });

  it("если ход закончился без ответа — одно напоминание", async () => {
    const { p, events } = await participant("answer_on_reminder");
    const r = await ask(p);
    expect(r.ok).toBe(true);
    expect(r.usage.calls).toBe(2);
    const prompts = events().filter((e) => e.event === "prompt");
    expect(String(prompts[1]?.text)).toContain("Ты не вызвал инструмент submit_vote");
  });

  it("нет ответа и после напоминания — no_answer", async () => {
    const { p } = await participant("no_answer");
    const r = await ask(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe("no_answer");
  });

  it("таймаут раунда отменяет ход", async () => {
    const { p, events } = await participant("hang");
    const r = await ask(p, 1);
    expect(!r.ok && r.error.kind).toBe("timeout");
    expect(events().some((e) => e.event === "cancel")).toBe(true);
  });

  it("внешняя отмена — cancelled", async () => {
    const { p } = await participant("hang");
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);
    const r = await ask(p, 20, controller.signal);
    expect(!r.ok && r.error.kind).toBe("cancelled");
  });

  it("агент, который игнорирует отмену, помечается упавшим", async () => {
    const { p } = await participant("hang_hard");
    const r = await ask(p, 1);
    expect(!r.ok && r.error.kind).toBe("timeout");
    const next = await ask(p, 1);
    expect(!next.ok && next.error.kind).toBe("agent_exited");
  }, 20_000);

  it("падение агента — agent_exited", async () => {
    const { p } = await participant("crash");
    const r = await ask(p);
    expect(!r.ok && r.error.kind).toBe("agent_exited");
  });

  it("запросы прав автоматически отклоняются", async () => {
    const { p, events } = await participant("ask_permission");
    expect((await ask(p)).ok).toBe(true);
    expect(events().find((e) => e.event === "permission")?.outcome).toEqual({
      outcome: "selected",
      optionId: "reject",
    });
  });

  it("агент без MCP по HTTP — понятная ошибка при запуске", async () => {
    await expect(participant("no_http")).rejects.toThrow(/не поддерживает MCP по HTTP/);
  });

  it("несуществующая команда — понятная ошибка", async () => {
    const driver = new AcpDriver(base, { profile: customProfile(["/nonexistent/agent"]) });
    drivers.push(driver);
    await expect(
      driver.open({ alias: "A", model: base.models[0]!, tools: [tool] }),
    ).rejects.toThrow(/не удалось запустить «\/nonexistent\/agent»/);
  });
});
