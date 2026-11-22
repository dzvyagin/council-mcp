import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import type { CouncilRuntime } from "./runtime.js";
import { buildMcpServer } from "./server.js";

/** stdio — основной транспорт: хост сам запускает процесс сервера. */
export async function serveStdio(
  runtime: CouncilRuntime,
  waitS?: number,
): Promise<() => Promise<void>> {
  const server = buildMcpServer(runtime, waitS);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  runtime.logger.info("council MCP server: stdio");
  return async () => {
    await runtime.shutdown();
    await server.close();
  };
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Bearer-токен. Обязателен, если сервер слушает не loopback. */
  token?: string;
  waitS?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Streamable HTTP без сессий (stateless): MCP-сервер на каждый запрос, общее состояние запусков —
 * в runtime. Для веб-агента и для «одного адреса на все хосты».
 */
export async function serveHttp(
  runtime: CouncilRuntime,
  options: HttpOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const loopback = LOOPBACK.has(options.host);
  if (!loopback && !options.token) {
    throw new Error("для адреса, отличного от loopback, задайте COUNCIL_HTTP_TOKEN (Bearer-токен)");
  }
  const validateHost = loopback ? localhostHostValidation() : hostHeaderValidation([options.host]);
  const validateOrigin = localhostOriginValidation();
  const expected = options.token ? Buffer.from(`Bearer ${options.token}`) : undefined;

  const http: Server = createServer((req, res) => {
    void (async () => {
      if (!validateHost(req, res)) return;
      if (req.headers.origin !== undefined && !validateOrigin(req, res)) return;
      if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (expected) {
        const got = Buffer.from(req.headers.authorization ?? "");
        if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
          res.writeHead(401, { "www-authenticate": "Bearer" }).end();
          return;
        }
      }
      const server = buildMcpServer(runtime, options.waitS);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        runtime.logger.error({ err: e }, "MCP HTTP request failed");
        if (!res.headersSent) res.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${host}:${String(port)}/mcp`;
  runtime.logger.info({ url }, "council MCP server: streamable HTTP");
  return {
    url,
    close: async () => {
      await runtime.shutdown();
      await new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
        http.closeAllConnections();
      });
    },
  };
}
