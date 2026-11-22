/**
 * E2E с настоящим `opencode acp` (V2). Запуск: COUNCIL_E2E=1 npm test -- test/e2e
 *
 * 1. «Фейковый провайдер»: локальный OpenAI-совместимый сервер со скриптом ответов. Проверяет,
 *    что opencode принимает наш конфиг, видит инструмент ответа совета, не получает инструментов
 *    записи/шелла/веба, и что ответ доходит до council-mcp.
 * 2. «Реальный эндпоинт»: если заданы COUNCIL_BASE_URL/COUNCIL_API_KEY/COUNCIL_MODELS —
 *    голосование на настоящих моделях.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, nodeConfigDeps } from "../../src/core/config.js";
import { deliberate } from "../../src/core/deliberate.js";
import { AcpDriver } from "../../src/drivers/acp/driver.js";
import { opencodeProfile, which } from "../../src/drivers/acp/profiles.js";
import { baseEnv, fakeDeps } from "../helpers.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");

interface ChatRequest {
  model: string;
  tools?: { function: { name: string } }[];
  messages: { role: string }[];
}

/** Минимальный OpenAI-совместимый сервер: на первый запрос — вызов инструмента ответа, потом текст. */
function fakeProvider(answer: Record<string, unknown>) {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-a" }, { id: "fake-b" }] }));
        return;
      }
      const chat = JSON.parse(body || "{}") as ChatRequest;
      requests.push(chat);
      const toolName = chat.tools
        ?.map((t) => t.function.name)
        .find((n) => n.endsWith("submit_vote"));
      const alreadyCalled = chat.messages.some((m) => m.role === "tool");
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: chat.model };
      const chunks: unknown[] =
        toolName && !alreadyCalled
          ? [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          type: "function",
                          function: { name: toolName, arguments: JSON.stringify(answer) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            ]
          : [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "Готово." },
                    finish_reason: null,
                  },
                ],
              },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
}

describe.runIf(enabled && opencode)("e2e: opencode acp + фейковый провайдер", () => {
  let workspace: string;
  const provider = fakeProvider({
    choice: "gRPC",
    confidence: 0.9,
    rationale: "protobuf уже есть",
  });

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "council-e2e-"));
    writeFileSync(
      join(workspace, "README.md"),
      "# demo\nВнутренние сервисы общаются по protobuf.\n",
    );
    writeFileSync(join(workspace, ".env"), "DB_PASSWORD=hunter2\n");
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    provider.server.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("vote доходит до council-mcp; инструментов записи и шелла у модели нет", async () => {
    const { port } = provider.server.address() as AddressInfo;
    const config = loadConfig(
      fakeDeps({
        ...baseEnv,
        COUNCIL_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        COUNCIL_MODELS: "fake-a,fake-b",
        COUNCIL_WORKSPACE: workspace,
      }),
    );
    const driver = new AcpDriver(config, { profile: opencodeProfile(opencode!) });
    try {
      const r = await deliberate(
        { mode: "vote", question: "REST или gRPC?", options: ["REST", "gRPC"] },
        { config, driver, runId: "e2e-opencode" },
      );
      expect(r.status).toBe("converged");
      expect(r.decision).toBe("gRPC");
    } finally {
      await driver.dispose();
    }

    // Служебный агент title отключён: запросов без инструментов (генерация заголовка) нет.
    expect(provider.requests.filter((q) => (q.tools ?? []).length === 0)).toHaveLength(0);
    const toolNames = new Set(
      provider.requests.flatMap((q) => q.tools?.map((t) => t.function.name) ?? []),
    );
    expect([...toolNames].some((n) => n.endsWith("submit_vote"))).toBe(true);
    for (const forbidden of ["edit", "write", "patch", "shell", "bash", "webfetch", "websearch"]) {
      expect(toolNames.has(forbidden)).toBe(false);
    }
    const sent = JSON.stringify(provider.requests);
    expect(sent).not.toContain("hunter2");
    // У каждого участника своя модель, и обе модели участвовали.
    expect(new Set(provider.requests.map((q) => q.model))).toEqual(new Set(["fake-a", "fake-b"]));
  }, 180_000);
});

const real =
  enabled &&
  opencode !== undefined &&
  process.env.COUNCIL_BASE_URL !== undefined &&
  process.env.COUNCIL_API_KEY !== undefined;

describe.runIf(real)("e2e: реальный эндпоинт", () => {
  it("vote на настоящих моделях даёт валидный результат", async () => {
    const config = loadConfig(nodeConfigDeps());
    const driver = new AcpDriver(config);
    try {
      const r = await deliberate(
        {
          mode: "vote",
          question: "Для внутреннего API между сервисами этого репозитория лучше REST или gRPC?",
          options: ["REST", "gRPC"],
        },
        { config, driver, runId: `e2e-${String(Date.now())}` },
      );
      console.log(r.report);
      expect(["converged", "majority", "tie", "partial"]).toContain(r.status);
      expect(r.votes?.length).toBeGreaterThanOrEqual(1);
    } finally {
      await driver.dispose();
    }
  }, 900_000);
});
