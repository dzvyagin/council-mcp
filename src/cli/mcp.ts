import { parseArgs } from "node:util";

import { fileURLToPath } from "node:url";

import { nodeConfigDeps, type CouncilConfig } from "../core/config.js";
import { checkAgent } from "../drivers/acp/check.js";
import { which } from "../drivers/acp/profiles.js";
import { Redactor } from "../core/context/redact.js";
import type { ParticipantDriver } from "../core/participant.js";
import { createLogger } from "../mcp/logger.js";
import { CouncilRuntime } from "../mcp/runtime.js";
import { serveHttp, serveStdio } from "../mcp/serve.js";

/**
 * `council mcp` — MCP-сервер. По умолчанию stdio; `--http` — Streamable HTTP (loopback, или
 * другой адрес с COUNCIL_HTTP_TOKEN). Логи — только в stderr.
 */
export async function runMcp(
  argv: string[],
  makeDriver: (config: CouncilConfig) => ParticipantDriver,
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      "wait-s": { type: "string" },
    },
  });
  const env = process.env;
  const level = env.COUNCIL_LOG_LEVEL ?? "info";
  const logger = createLogger(
    level,
    new Redactor(env.COUNCIL_API_KEY ? [env.COUNCIL_API_KEY] : []),
  );
  const waitRaw = values["wait-s"] ?? env.COUNCIL_WAIT_S;
  const waitS = waitRaw === undefined ? undefined : Number(waitRaw);
  if (waitS !== undefined && (!Number.isInteger(waitS) || waitS < 0))
    throw new Error("--wait-s: целое число секунд");

  const runtime = new CouncilRuntime({
    configDeps: nodeConfigDeps,
    makeDriver,
    logger,
    checkAgent,
    which: (command) => which(command),
    bundlePath: fileURLToPath(import.meta.url),
  });
  const state = runtime.config();
  if (!state.ok)
    logger.warn(
      { error: state.error },
      "конфигурация неполная: инструменты вернут понятную ошибку",
    );

  let close: () => Promise<void>;
  if (values.http) {
    const port = Number(values.port ?? env.COUNCIL_HTTP_PORT ?? 8765);
    const served = await serveHttp(runtime, {
      host: values.host ?? env.COUNCIL_HTTP_HOST ?? "127.0.0.1",
      port,
      ...(env.COUNCIL_HTTP_TOKEN !== undefined && { token: env.COUNCIL_HTTP_TOKEN }),
      ...(waitS !== undefined && { waitS }),
    });
    process.stderr.write(`council MCP: ${served.url}\n`);
    close = served.close;
  } else {
    close = await serveStdio(runtime, waitS);
    // Хост закрыл stdin — завершаемся, останавливая участников.
    process.stdin.on("end", () => void shutdown("stdin closed"));
  }

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, "council MCP server stopping");
    await close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
