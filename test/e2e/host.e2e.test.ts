/**
 * E2E «плагин из git → автозапуск совета»: council ставится как у пользователя
 * (`scripts/release.mjs --dir` + `opencode plugin add git+file://…`), в проект ничего не
 * копируется. Пользователь задаёт обычный вопрос без слэш-команды; плагин добавляет правило в
 * системный промпт, хост-модель сама вызывает совет через MCP-сервер, зарегистрированный
 * плагином. Хост-модель и участники — скриптовый провайдер. Запуск: COUNCIL_E2E=1 npm run test:e2e
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { which } from "../../src/drivers/acp/profiles.js";
import { fakeProvider } from "./fake-provider.js";
import { addHostModel, installPlugin, opencodeEnv } from "./install.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");

describe.runIf(enabled && opencode)("e2e: плагин из git, совет запускается сам", () => {
  const provider = fakeProvider();
  let home: string;
  let workspace: string;
  let baseURL: string;

  beforeAll(async () => {
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
    baseURL = `http://127.0.0.1:${String((provider.server.address() as AddressInfo).port)}/v1`;
    const installed = installPlugin(opencode!);
    home = installed.home;
    // Настройки совета — в options плагина (как у пользователя в opencode.json), не в окружении.
    addHostModel(installed.globalConfig, baseURL, {
      baseURL,
      apiKey: "sk-host-e2e-key-123456",
      models: ["fake-a", "fake-b"],
      agent: "opencode",
    });
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "council-host-ws-")));
    writeFileSync(
      join(workspace, "README.md"),
      "# payments\nВнутренние сервисы общаются по protobuf.\n",
    );
    writeFileSync(join(workspace, ".env"), "DB_PASSWORD=hunter2\n");
  });

  afterAll(() => {
    provider.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("обычный вопрос → хост сам вызывает совет, ждёт через council_wait; ADR в репозитории", async () => {
    // В окружении opencode нет ни одной COUNCIL_* — всё из options плагина.
    const env: Record<string, string> = { ...opencodeEnv(home), FAKE_KEY: "fake" };
    // Хост ведём через ACP, как Zed или другой клиент.
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
      void session.prompt("Как партиционировать таблицу платежей?");
      // Ждём, пока отчёт совета дойдёт до хоста результатом инструмента.
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && !reportDelivered())
        await new Promise((r) => setTimeout(r, 500));
    } finally {
      connection.close();
      child.kill("SIGTERM");
    }
    if (!reportDelivered()) console.log(stderr.slice(-3000));

    // В системном промпте — правило автозапуска и Skill; хост сам вызвал council_deliberate,
    // затем council_wait.
    const host = hostRequests();
    expect(host.length).toBeGreaterThan(1);
    const system = JSON.stringify(host[0]?.messages.filter((m) => m.role === "system"));
    expect(system).toContain("<council-rule>");
    expect(system).toContain("<council-hint>");
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
    // Установка ничего не положила в проект: только README, .env и артефакты совета.
    expect(readdirSync(workspace).sort()).toEqual([".council", ".env", "README.md", "docs"]);
    expect(JSON.stringify(provider.requests)).not.toContain("hunter2");
  }, 300_000);
});
