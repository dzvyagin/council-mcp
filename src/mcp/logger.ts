import { pino, type Logger } from "pino";

import type { Redactor } from "../core/context/redact.js";

/** Логи только в stderr: stdout занят stdio-транспортом MCP. Секреты маскируются. */
export function createLogger(level: string, redactor?: Redactor): Logger {
  return pino(
    {
      level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      ...(redactor && {
        hooks: {
          logMethod(args, method) {
            method.apply(this, redactor.deep<Parameters<typeof method>>(args));
          },
        },
      }),
    },
    pino.destination({ fd: 2, sync: true }),
  );
}
