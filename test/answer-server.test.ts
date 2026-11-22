import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AnswerServer } from "../src/drivers/acp/answer-server.js";

const tool = {
  name: "submit_vote",
  description: "Сдать голос",
  schema: z.object({ choice: z.enum(["a", "b"]), confidence: z.number().min(0).max(1) }),
};

let server: AnswerServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function rpc(url: string, token: string, method: string, params?: unknown, id = 1) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? text);
  const body = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  return { status: res.status, body };
}

describe("AnswerServer", () => {
  it("публикует инструмент со схемой, отклоняет невалидный ответ и принимает валидный", async () => {
    server = await AnswerServer.start();
    const { token, endpoint } = server.register([tool]);
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const init = await rpc(endpoint.url, token, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);

    const list = await rpc(endpoint.url, token, "tools/list");
    const tools = (list.body.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["submit_vote"]);
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain('"enum":["a","b"]');

    const expectation = server.expect(token, "submit_vote");
    const bad = await rpc(endpoint.url, token, "tools/call", {
      name: "submit_vote",
      arguments: { choice: "c", confidence: 2 },
    });
    expect(JSON.stringify(bad.body)).toMatch(/isError|error/);

    const good = await rpc(endpoint.url, token, "tools/call", {
      name: "submit_vote",
      arguments: { choice: "a", confidence: 0.5 },
    });
    expect(JSON.stringify(good.body)).toContain("Ответ принят");
    await expect(expectation.promise).resolves.toEqual({ choice: "a", confidence: 0.5 });
  });

  it("ответ без ожидания отклоняется", async () => {
    server = await AnswerServer.start();
    const { token, endpoint } = server.register([tool]);
    const r = await rpc(endpoint.url, token, "tools/call", {
      name: "submit_vote",
      arguments: { choice: "a", confidence: 0.5 },
    });
    expect(JSON.stringify(r.body)).toContain("Сейчас ответ не ожидается");
  });

  it("без токена или с чужим токеном — 401", async () => {
    server = await AnswerServer.start();
    const { endpoint } = server.register([tool]);
    expect((await fetch(endpoint.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await rpc(endpoint.url, "0".repeat(48), "tools/list")).status).toBe(401);
  });
});
