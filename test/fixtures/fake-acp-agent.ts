/**
 * Фейковый ACP-агент для тестов драйвера. Поведение задаётся env:
 *   FAKE_BEHAVIOR  answer | answer_on_reminder | no_answer | invalid_then_answer | hang | hang_hard |
 *                  crash | ask_permission | no_http
 *   FAKE_ANSWER    JSON аргументов инструмента
 *   FAKE_TOOL      имя инструмента (по умолчанию submit_vote)
 *   FAKE_LOG       файл JSONL, куда агент пишет, что получил
 */
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const behavior = process.env.FAKE_BEHAVIOR ?? "answer";
const tool = process.env.FAKE_TOOL ?? "submit_vote";
const answer: unknown = JSON.parse(
  process.env.FAKE_ANSWER ?? '{"choice":"a","confidence":0.8,"rationale":"r"}',
);
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
};

let mcp: { url: string; headers: { name: string; value: string }[] } | undefined;
let prompts = 0;
let cancel: (() => void) | undefined;

async function callTool(args: unknown): Promise<string> {
  if (!mcp) throw new Error("no mcp server");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  };
  for (const h of mcp.headers) headers[h.name] = h.value;
  const res = await fetch(mcp.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  return res.text();
}

const say = (cx: acp.AgentContext, sessionId: string, text: string) =>
  cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", (ctx) => {
    log({ event: "initialize", clientCapabilities: ctx.params.clientCapabilities });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { mcpCapabilities: { http: behavior !== "no_http", sse: false } },
    };
  })
  .onRequest("session/new", (ctx) => {
    const server = ctx.params.mcpServers[0];
    if (server && "url" in server) mcp = { url: server.url, headers: server.headers };
    log({
      event: "session/new",
      cwd: ctx.params.cwd,
      mcpServers: ctx.params.mcpServers,
      env: {
        hasConfig: process.env.OPENCODE_CONFIG_CONTENT !== undefined,
        model: process.env.COUNCIL_PARTICIPANT_MODEL,
        home: process.env.HOME,
        leaked: process.env.FAKE_SECRET_SHOULD_NOT_LEAK,
      },
    });
    return { sessionId: "s1" };
  })
  .onRequest("session/set_config_option", (ctx) => {
    log({ event: "set_config_option", configId: ctx.params.configId, value: ctx.params.value });
    return { configOptions: [] };
  })
  .onRequest("session/prompt", async (ctx) => {
    prompts++;
    const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    log({ event: "prompt", n: prompts, text });
    const sid = ctx.params.sessionId;
    const usage = { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 };

    switch (behavior) {
      case "crash":
        process.exit(3);
        break;
      case "hang":
        await new Promise<void>((resolve) => {
          cancel = resolve;
        });
        return { stopReason: "cancelled" };
      case "hang_hard":
        await new Promise(() => undefined);
        break;
      case "no_answer":
        await say(ctx.client, sid, "думаю…");
        return { stopReason: "end_turn", usage };
      case "answer_on_reminder":
        if (prompts === 1) return { stopReason: "end_turn", usage };
        break;
      case "invalid_then_answer":
        log({ event: "invalid", result: await callTool({ choice: 42 }) });
        break;
      case "ask_permission": {
        const r = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: sid,
          toolCall: { toolCallId: "t1", title: "edit src/app.ts", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        log({ event: "permission", outcome: r.outcome });
        break;
      }
    }
    await say(ctx.client, sid, "изучил проект");
    log({ event: "answer", result: await callTool(answer) });
    return { stopReason: "end_turn", usage };
  })
  .onNotification("session/cancel", () => {
    log({ event: "cancel" });
    cancel?.();
  })
  .connect(stream);
