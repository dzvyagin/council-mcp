/**
 * E2E «хост → MCP → участники»: настоящий opencode (`opencode run`) с MCP-сервером council из
 * собранного бандла и командой /council из integrations/opencode. Хост-модель и участники —
 * скриптовый OpenAI-совместимый провайдер. Запуск: COUNCIL_E2E=1 npm run test:e2e
 */
import { execFileSync, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { which } from "../../src/drivers/acp/profiles.js";
import { fakeProvider } from "./fake-provider.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(ROOT, "dist/cli/index.js");

describe.runIf(enabled && opencode)("e2e: opencode как хост, /council через MCP", () => {
  const provider = fakeProvider();
  let home: string;
  let workspace: string;
  let baseURL: string;

  beforeAll(async () => {
    execFileSync(process.execPath, [join(ROOT, "node_modules/tsup/dist/cli-default.js")], {
      cwd: ROOT,
      stdio: "ignore",
    });
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
    baseURL = `http://127.0.0.1:${String((provider.server.address() as AddressInfo).port)}/v1`;
    home = mkdtempSync(join(tmpdir(), "council-host-home-"));
    workspace = mkdtempSync(join(tmpdir(), "council-host-ws-"));
    writeFileSync(
      join(workspace, "README.md"),
      "# payments\nВнутренние сервисы общаются по protobuf.\n",
    );
    writeFileSync(join(workspace, ".env"), "DB_PASSWORD=hunter2\n");
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    cpSync(join(ROOT, "integrations/opencode/commands"), join(workspace, ".opencode/commands"), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, "opencode.jsonc"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: "fake/host",
          update: "disable",
          share: "disabled",
          providers: {
            fake: {
              name: "Fake",
              env: ["FAKE_KEY"],
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL },
              models: {
                host: {
                  modelID: "host",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 128000, output: 8000 },
                },
              },
            },
          },
          agents: { title: { disabled: true } },
          mcp: {
            servers: {
              council: {
                type: "local",
                command: [process.execPath, BUNDLE, "mcp"],
                environment: {
                  COUNCIL_BASE_URL: baseURL,
                  COUNCIL_API_KEY: "sk-host-e2e-key-123456",
                  COUNCIL_MODELS: "fake-a,fake-b",
                  COUNCIL_WORKSPACE: ".",
                  COUNCIL_AGENT: "opencode",
                },
                codemode: false,
              },
            },
          },
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    provider.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("/council: хост вызывает совет, ждёт через council_wait, показывает отчёт; ADR в репозитории", async () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      FAKE_KEY: "fake",
    };
    // Хост ведём через ACP, как Zed или другой клиент: в этом режиме opencode разбирает слэш-команды
    // (`opencode run` отправляет «/council …» модели как обычный текст).
    const child = spawn(opencode!, ["acp"], {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const connection = acp
      .client({ name: "e2e-host" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const allow = ctx.params.options.find((o) => o.kind.startsWith("allow"));
        return allow
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } };
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      );
    const hostRequests = () =>
      provider.requests.filter((q) =>
        q.tools?.some((t) => t.function.name === "council_council_deliberate"),
      );
    const reportText = () =>
      hostRequests()
        .flatMap((q) =>
          q.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)),
        )
        .find((t) => t.includes("<council-output"));
    const reportDelivered = () => reportText() !== undefined;
    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.agent.buildSession(workspace).start();
      void session.prompt("/council Как партиционировать таблицу платежей?");
      // Команда выполняется фоновым ходом (ответ на prompt приходит раньше её работы), и его
      // обновления в эту ACP-сессию не транслируются. Ждём, пока отчёт совета дойдёт до хоста
      // результатом инструмента.
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && !reportDelivered())
        await new Promise((r) => setTimeout(r, 500));
    } finally {
      connection.close();
      child.kill("SIGTERM");
    }
    if (!reportDelivered()) console.log(stderr.slice(-3000));

    // Хост прошёл через команду /council → council_deliberate → council_wait.
    const host = hostRequests();
    expect(host.length).toBeGreaterThan(1);
    const firstUser = JSON.stringify(host[0]?.messages.filter((m) => m.role === "user"));
    expect(firstUser).toContain("Запусти совет моделей (MCP-сервер council)");
    expect(firstUser).toContain("Как партиционировать таблицу платежей?");
    const hostCalls = host.flatMap((q) =>
      q.messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name),
    );
    expect(hostCalls).toContain("council_council_wait");

    // Отчёт дошёл до хоста как недоверенные данные; ADR и транскрипт — в репозитории.
    expect(reportText()).toMatch(
      /<council-output trust=\\"untrusted\\"[^>]*>\\n🏛 Council · consensus/,
    );
    const adrs = readdirSync(join(workspace, "docs/adr")).filter((f) => /^\d{4}-/.test(f));
    expect(adrs).toHaveLength(1);
    expect(readFileSync(join(workspace, "docs/adr", adrs[0]!), "utf8")).toMatch(
      /^# 0001\. Как партиционировать таблицу платежей\?/,
    );
    expect(existsSync(join(workspace, ".council/.gitignore"))).toBe(true);
    expect(JSON.stringify(provider.requests)).not.toContain("hunter2");
  }, 300_000);
});
