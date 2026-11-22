/**
 * E2E плагина opencode V2 (настоящий opencode, плагин из `council setup`): правка миграции без
 * решения совета блокируется; COUNCIL_GUARD=off снимает защиту; состояние активного процесса
 * совета попадает в системный промпт каждого запроса (переживает сжатие контекста).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/core/config.js";
import { WorkflowMachine } from "../../src/core/workflow/machine.js";
import { which } from "../../src/drivers/acp/profiles.js";
import { baseEnv, fakeDeps } from "../helpers.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION = "db/migrations/001_init.sql";

interface Req {
  tools?: { function: { name: string } }[];
  messages: { role: string; content?: unknown; tool_calls?: unknown[] }[];
}

/** Хост-модель: один раз пытается отредактировать миграцию, затем отвечает текстом. */
function editingProvider() {
  const requests: Req[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const chat = JSON.parse(body || "{}") as Req;
      requests.push(chat);
      const tried = chat.messages.some((m) => m.role === "tool");
      const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "host" };
      const delta = tried
        ? { role: "assistant", content: "Готово." }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_edit",
                type: "function",
                function: {
                  name: "edit",
                  arguments: JSON.stringify({
                    path: MIGRATION,
                    oldString: "-- init",
                    newString: "-- changed",
                  }),
                },
              },
            ],
          };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tried ? "stop" : "tool_calls" }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
}

describe.runIf(enabled && opencode)(
  "e2e: плагин opencode — защита путей и состояние совета",
  () => {
    const provider = editingProvider();
    let ws: string;
    let home: string;

    beforeAll(async () => {
      execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
      await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
      const baseURL = `http://127.0.0.1:${String((provider.server.address() as AddressInfo).port)}/v1`;
      ws = realpathSync(mkdtempSync(join(tmpdir(), "council-plugin-ws-")));
      home = mkdtempSync(join(tmpdir(), "council-plugin-home-"));
      execFileSync(
        process.execPath,
        [join(ROOT, "dist/cli/index.js"), "setup", "--host", "opencode"],
        {
          cwd: ws,
          env: { PATH: process.env.PATH ?? "", HOME: home },
          stdio: "ignore",
        },
      );
      mkdirSync(join(ws, "db/migrations"), { recursive: true });
      writeFileSync(join(ws, MIGRATION), "-- init\n");
      // Хост без MCP-сервера: плагин работает сам по себе. Провайдер — фейковый.
      writeFileSync(
        join(ws, "opencode.jsonc"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "fake/host",
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
        }),
      );
      // Активный процесс совета — его сводка должна попасть в системный промпт.
      const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: ws }));
      await new WorkflowMachine({ config, newId: () => "wf-plugin" }).start(
        "Партиционирование платежей",
        "supervised",
      );
    });
    afterAll(() => {
      provider.server.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    async function hostTurn(extraEnv: Record<string, string>): Promise<Req[]> {
      const before = provider.requests.length;
      const env = {
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
        ...extraEnv,
      };
      const child = spawn(opencode!, ["acp"], { cwd: ws, env, stdio: ["pipe", "pipe", "pipe"] });
      const connection = acp
        .client({ name: "e2e-plugin" })
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
      try {
        await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.agent.buildSession(ws).start();
        await session.prompt("Поменяй комментарий в миграции");
        const deadline = Date.now() + 60_000;
        while (
          Date.now() < deadline &&
          !provider.requests.slice(before).some((r) => r.messages.some((m) => m.role === "tool"))
        ) {
          await new Promise((r) => setTimeout(r, 300));
        }
      } finally {
        connection.close();
        child.kill("SIGTERM");
      }
      return provider.requests.slice(before);
    }

    const toolResult = (reqs: Req[]) =>
      reqs
        .flatMap((r) =>
          r.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)),
        )
        .join("\n");

    it("правка миграции без решения совета блокируется; сводка процесса — в системном промпте", async () => {
      const reqs = await hostTurn({});
      expect(toolResult(reqs)).toContain("нужно решение совета");
      expect(readFileSync(join(ws, MIGRATION), "utf8")).toBe("-- init\n");
      const system = JSON.stringify(reqs[0]?.messages.filter((m) => m.role === "system"));
      expect(system).toContain("<council-state>");
      expect(system).toContain("Активный процесс совета wf-plugin");
    }, 120_000);

    it("COUNCIL_GUARD=off снимает защиту", async () => {
      const reqs = await hostTurn({ COUNCIL_GUARD: "off" });
      expect(toolResult(reqs)).not.toContain("нужно решение совета");
      expect(readFileSync(join(ws, MIGRATION), "utf8")).toBe("-- changed\n");
    }, 120_000);
  },
);
