import { parseArgs } from "node:util";

import { ConfigError, describeConfig, loadConfig, type ConfigDeps } from "../core/config.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configDeps: () => ConfigDeps;
  debug: boolean;
}

const HELP = `council — совет моделей для архитектурных решений

Использование:
  council info        показать конфигурацию (без секретов)
  council help        эта справка

Переменные окружения:
  COUNCIL_BASE_URL    OpenAI-совместимый эндпоинт (обязательно)
  COUNCIL_API_KEY     ключ доступа (обязательно)
  COUNCIL_MODELS      модели через запятую, минимум две (или models в council.config.json)
  COUNCIL_WORKSPACE   корень проекта (по умолчанию текущая папка)
  COUNCIL_CONFIG      путь к council.config.json
`;

/** Точка входа CLI. Возвращает код выхода; не бросает исключения наружу. */
export function main(argv: string[], io: CliIO): number {
  try {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true });
    const command = positionals[0] ?? "help";

    switch (command) {
      case "help":
        io.stdout(HELP);
        return 0;
      case "info": {
        const config = loadConfig(io.configDeps());
        io.stdout(`${JSON.stringify(describeConfig(config), null, 2)}\n`);
        return 0;
      }
      default:
        io.stderr(`Неизвестная команда: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    if (isUsageError(error)) {
      io.stderr(`council: ${error.message}\n\n${HELP}`);
      return 2;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    io.stderr(`council: ${err.message}\n`);
    if (io.debug && err.stack) io.stderr(`${err.stack}\n`);
    return 1;
  }
}

function isUsageError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    ((error as NodeJS.ErrnoException).code ?? "").startsWith("ERR_PARSE_ARGS_")
  );
}
