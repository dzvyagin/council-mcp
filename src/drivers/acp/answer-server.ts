import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";

import type { AnswerTool } from "../../core/participant.js";

/**
 * Loopback MCP-сервер, через который участники сдают ответы раунда.
 *
 * У opencode нет вывода по JSON-схеме, поэтому ответ — это вызов инструмента с типизированным
 * входом: схема раунда видна модели, аргументы проверяются здесь (zod), ошибка валидации уходит
 * модели на исправление. Сервер слушает только 127.0.0.1, у каждого участника свой токен.
 */

export interface AnswerEndpoint {
  url: string;
  headers: { name: string; value: string }[];
}

interface Pending {
  tool: string;
  validate?: ((args: unknown) => string | undefined) | undefined;
  resolve: (value: unknown) => void;
}

interface Registration {
  tools: AnswerTool[];
  pending?: Pending;
  /** Ответы, пришедшие без ожидания (например, повторные): для диагностики. */
  stray: number;
}

export interface Expectation {
  promise: Promise<unknown>;
  cancel: () => void;
}

export class AnswerServer {
  private readonly registrations = new Map<string, Registration>();
  private readonly validateHost = localhostHostValidation();
  private readonly validateOrigin = localhostOriginValidation();

  private constructor(
    private readonly server: Server,
    private readonly port: number,
  ) {}

  static async start(): Promise<AnswerServer> {
    const holder: { instance?: AnswerServer } = {};
    const server = createServer((req, res) => {
      void holder.instance?.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    holder.instance = new AnswerServer(server, port);
    return holder.instance;
  }

  /** Регистрирует участника и его инструменты; возвращает адрес для session/new.mcpServers. */
  register(tools: AnswerTool[]): { token: string; endpoint: AnswerEndpoint } {
    const token = randomBytes(24).toString("hex");
    this.registrations.set(token, { tools, stray: 0 });
    return {
      token,
      endpoint: {
        url: `http://127.0.0.1:${this.port}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    };
  }

  unregister(token: string): void {
    this.registrations.get(token)?.pending?.resolve(undefined);
    this.registrations.delete(token);
  }

  /** Ждать валидный вызов инструмента `tool` от участника; `validate` — правила раунда сверх схемы. */
  expect(
    token: string,
    tool: string,
    validate?: (args: unknown) => string | undefined,
  ): Expectation {
    const reg = this.registrations.get(token);
    if (!reg) throw new Error("участник не зарегистрирован в AnswerServer");
    let settle!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    reg.pending = { tool, validate, resolve: settle };
    return {
      promise,
      cancel: () => {
        if (reg.pending?.resolve === settle) delete reg.pending;
      },
    };
  }

  async close(): Promise<void> {
    for (const token of [...this.registrations.keys()]) this.unregister(token);
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private tokenOf(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    const match = header ? /^Bearer ([0-9a-f]{48})$/.exec(header) : null;
    return match?.[1];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.validateHost(req, res) || !this.validateOrigin(req, res)) return;
    const token = this.tokenOf(req);
    const reg = token !== undefined ? this.registrations.get(token) : undefined;
    if (!reg || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
      res.writeHead(token === undefined || !reg ? 401 : 404).end();
      return;
    }
    try {
      const mcp = this.buildServer(reg);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private buildServer(reg: Registration): McpServer {
    const mcp = new McpServer({ name: "council", version: "0.0.0" });
    for (const tool of reg.tools) {
      mcp.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema },
        (args: unknown) => {
          const pending = reg.pending;
          if (pending?.tool !== tool.name) {
            reg.stray++;
            const hint = pending
              ? `Сейчас ожидается ${pending.tool}.`
              : "Сейчас ответ не ожидается.";
            return { isError: true, content: [{ type: "text", text: hint }] };
          }
          const problem = pending.validate?.(args);
          if (problem !== undefined) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Ответ не принят: ${problem}. Исправь и вызови ${tool.name} снова.`,
                },
              ],
            };
          }
          delete reg.pending;
          pending.resolve(args);
          return {
            content: [
              { type: "text", text: "Ответ принят. Заверши ход без дополнительных действий." },
            ],
          };
        },
      );
    }
    return mcp;
  }
}
