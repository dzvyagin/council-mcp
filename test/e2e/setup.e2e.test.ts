/**
 * E2E «setup → /council»: в чистом git-репозитории `council setup --host opencode` (собранный бандл)
 * готовит проект, затем настоящий opencode как хост выполняет /council через MCP-сервер из
 * сгенерированного opencode.jsonc. В конфиг добавляется только фейковый провайдер для модели хоста.
 */
import { execFileSync, spawn } from "node:child_process";
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
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { which } from "../../src/drivers/acp/profiles.js";
import { gitRepo } from "../helpers.js";
import { fakeProvider } from "./fake-provider.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(ROOT, "dist/cli/index.js");

describe.runIf(enabled && opencode)(
  "e2e: council setup в чистом репозитории → рабочий /council",
  () => {
    const provider = fakeProvider();
    let ws: string;
    let home: string;
    let baseURL: string;
    const env = () => ({
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
      COUNCIL_BASE_URL: baseURL,
      COUNCIL_API_KEY: "sk-setup-e2e-123456",
      COUNCIL_MODELS: "fake-a,fake-b",
    });

    beforeAll(async () => {
      execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
      await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
      baseURL = `http://127.0.0.1:${String((provider.server.address() as AddressInfo).port)}/v1`;
      ws = realpathSync(mkdtempSync(join(tmpdir(), "council-setup-ws-")));
      home = mkdtempSync(join(tmpdir(), "council-setup-home-"));
      gitRepo(ws);
      writeFileSync(
        join(ws, "README.md"),
        "# payments\nВнутренние сервисы общаются по protobuf.\n",
      );
    });
    afterAll(() => {
      provider.server.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it("setup готовит проект; /council в opencode доходит до отчёта и ADR", async () => {
      // Асинхронно: фейковый провайдер живёт в этом же процессе и должен отвечать doctor.
      const res = await new Promise<{ status: number | null; out: string; err: string }>(
        (resolve) => {
          const p = spawn(process.execPath, [BUNDLE, "setup", "--host", "opencode"], {
            cwd: ws,
            env: env(),
          });
          let out = "";
          let err = "";
          p.stdout.on("data", (c: Buffer) => (out += c.toString()));
          p.stderr.on("data", (c: Buffer) => (err += c.toString()));
          p.on("exit", (status) => {
            resolve({ status, out, err });
          });
        },
      );
      const out = res.out;
      if (res.status !== 0) console.log(out, res.err);
      expect(res.status).toBe(0);
      expect(out).toMatch(/🏛 Council · setup/);
      expect(out).toMatch(/🏛 Council · doctor/);
      for (const f of [
        "opencode.jsonc",
        ".opencode/commands/council.md",
        ".opencode/agents/conductor.md",
        "AGENTS.md",
        "council.config.json",
        ".agents/skills/council/SKILL.md",
      ]) {
        expect(existsSync(join(ws, f)), f).toBe(true);
      }

      // Пользователь добавляет свой провайдер для модели хоста — остальное из setup как есть.
      const config = JSON.parse(readFileSync(join(ws, "opencode.jsonc"), "utf8")) as Record<
        string,
        unknown
      >;
      Object.assign(config, {
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
      });
      writeFileSync(join(ws, "opencode.jsonc"), JSON.stringify(config, null, 2));

      const child = spawn(opencode!, ["acp"], {
        cwd: ws,
        env: env(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const connection = acp
        .client({ name: "e2e-setup" })
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
      const delivered = () =>
        provider.requests.some((q) =>
          q.messages.some(
            (m) => m.role === "tool" && JSON.stringify(m.content).includes("<council-output"),
          ),
        );
      try {
        await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.agent.buildSession(ws).start();
        void session.prompt("/council Как партиционировать таблицу платежей?");
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline && !delivered()) await new Promise((r) => setTimeout(r, 500));
      } finally {
        connection.close();
        child.kill("SIGTERM");
      }
      expect(delivered()).toBe(true);
      expect(readdirSync(join(ws, "docs/adr")).filter((f) => /^\d{4}-/.test(f))).toHaveLength(1);
      // .council исключён из git: в статусе только то, что коммитит человек.
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: ws }).toString();
      expect(status).not.toContain(".council");
    }, 360_000);
  },
);
