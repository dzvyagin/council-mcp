/**
 * E2E «хост перезапустил MCP-сервер посреди совета»: opencode останавливает MCP-серверы
 * (SIGTERM) при правке конфига, простое, перезапуске сервиса. Совет идёт в отвязанном
 * рабочем процессе: после SIGTERM старого сервера новый сервер получает итог через council_wait.
 * Участники — настоящий `opencode acp` со скриптовым провайдером.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { which } from "../../src/drivers/acp/profiles.js";
import { fakeProvider } from "./fake-provider.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface ToolText {
  result?: { content: { text: string }[]; structuredContent?: Record<string, unknown> };
}

/** Минимальный MCP-клиент поверх stdio (JSON-RPC построчно). */
function mcpServer(env: Record<string, string>, cwd: string) {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [join(ROOT, "dist/cli/index.js"), "mcp"],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map<number, (msg: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as { id?: number };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      id++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    child,
    async init() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-restart", version: "0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    call: (name: string, args: Record<string, unknown>) =>
      request("tools/call", { name, arguments: args }) as Promise<ToolText>,
  };
}

describe.runIf(enabled && opencode)("e2e: совет переживает перезапуск MCP-сервера", () => {
  const provider = fakeProvider();
  let ws: string;
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
    const baseURL = `http://127.0.0.1:${String((provider.server.address() as AddressInfo).port)}/v1`;
    ws = realpathSync(mkdtempSync(join(tmpdir(), "council-restart-ws-")));
    home = mkdtempSync(join(tmpdir(), "council-restart-home-"));
    writeFileSync(join(ws, "README.md"), "# payments\nВнутренние сервисы общаются по protobuf.\n");
    env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      COUNCIL_BASE_URL: baseURL,
      COUNCIL_API_KEY: "sk-restart-e2e-123456",
      COUNCIL_MODELS: "fake-a,fake-b",
      COUNCIL_AGENT: "opencode",
      COUNCIL_WORKSPACE: ws,
    };
  });
  afterAll(() => {
    provider.server.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("SIGTERM старого сервера не прерывает совет; новый сервер отдаёт итог", async () => {
    const first = mcpServer(env, ws);
    await first.init();
    const started = await first.call("council_deliberate", {
      question: "REST или gRPC для внутреннего API?",
      mode: "vote",
      options: ["REST", "gRPC"],
      wait_s: 0,
    });
    const runId = started.result?.structuredContent?.run_id as string;
    expect(runId).toMatch(/^\d{8}-[0-9a-f]{6}$/);
    // Хост останавливает MCP-сервер, как opencode при перезапуске.
    first.child.kill("SIGTERM");
    await new Promise((r) => first.child.once("exit", r));

    const second = mcpServer(env, ws);
    await second.init();
    let last: ToolText | undefined;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      last = await second.call("council_wait", { run_id: runId, wait_s: 5 });
      if (last.result?.structuredContent?.status !== "running") break;
    }
    second.child.kill("SIGTERM");
    const text = last?.result?.content[0]?.text ?? "";
    expect(text).toMatch(/<council-output trust="untrusted"[^>]*>\n🏛 Council · vote/);
    expect(text).not.toMatch(/запуск отменён|остановлен/);
    expect(readdirSync(join(ws, ".council/jobs")).some((f) => f.startsWith(runId))).toBe(true);
  }, 300_000);
});
