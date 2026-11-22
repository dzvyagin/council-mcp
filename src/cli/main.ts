import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  ConfigError,
  describeConfig,
  loadConfig,
  type ConfigDeps,
  type CouncilConfig,
} from "../core/config.js";
import { deliberate, InputError } from "../core/deliberate.js";
import { probeEndpoint } from "../core/endpoint.js";
import type { CouncilEvent } from "../core/events.js";
import { defaultRunId } from "../core/jobs.js";
import { formatDuration, markerFor } from "../core/output/format.js";
import type { ParticipantDriver } from "../core/participant.js";
import type { Mode } from "../core/types.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configDeps: () => ConfigDeps;
  /** Драйвер участников; в тестах — фейк. Бросает ProfileError, если агент не найден. */
  makeDriver: (config: CouncilConfig) => ParticipantDriver;
  /** Описание агента для doctor (например, версия opencode). */
  describeAgent?: (config: CouncilConfig) => Promise<string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  debug: boolean;
}

const HELP = `council — совет моделей для архитектурных решений

Использование:
  council run --mode consensus|vote --question "<вопрос>" [--notes "<ограничения>"]
              [--file <путь>]... [--option A --option B] [--max-rounds N] [--diff-file <путь>] [--json]
  council doctor      проверить конфиг, эндпоинт, модели и агента-участника
  council info        показать конфигурацию (без секретов)
  council help        эта справка

Переменные окружения:
  COUNCIL_BASE_URL    OpenAI-совместимый эндпоинт (обязательно)
  COUNCIL_API_KEY     ключ доступа (обязательно)
  COUNCIL_MODELS      модели через запятую, минимум две (или models в council.config.json)
  COUNCIL_WORKSPACE   корень проекта (по умолчанию текущая папка)
  COUNCIL_CONFIG      путь к council.config.json
  COUNCIL_AGENT       auto | opencode | custom — чем запускать участников
`;

const MODES: Mode[] = ["consensus", "debate", "vote", "review"];

/** Точка входа CLI. Возвращает код выхода; не бросает исключения наружу. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  try {
    const command = argv[0] ?? "help";
    const rest = argv.slice(1);
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        io.stdout(HELP);
        return 0;
      case "info":
        parseArgs({ args: rest, strict: true });
        io.stdout(`${JSON.stringify(describeConfig(loadConfig(io.configDeps())), null, 2)}\n`);
        return 0;
      case "doctor":
        parseArgs({ args: rest, strict: true });
        return await doctor(io);
      case "run":
        return await run(rest, io);
      default:
        io.stderr(`Неизвестная команда: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    if (error instanceof InputError || isUsageError(error)) {
      io.stderr(`council: ${error.message}\n\n${HELP}`);
      return 2;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    io.stderr(`council: ${err.message}\n`);
    if (io.debug && err.stack) io.stderr(`${err.stack}\n`);
    return 1;
  }
}

async function run(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      mode: { type: "string", default: "vote" },
      question: { type: "string", short: "q" },
      option: { type: "string", multiple: true },
      notes: { type: "string" },
      file: { type: "string", multiple: true },
      "max-rounds": { type: "string" },
      "diff-file": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const mode = values.mode as Mode;
  if (!MODES.includes(mode)) throw new InputError(`--mode: ожидается ${MODES.join(" | ")}`);
  const question = values.question ?? positionals.join(" ");
  if (!question.trim()) throw new InputError('нужен вопрос: --question "…"');

  const maxRounds = values["max-rounds"] === undefined ? undefined : Number(values["max-rounds"]);
  if (maxRounds !== undefined && !Number.isInteger(maxRounds))
    throw new InputError("--max-rounds: целое число");
  const diffFile = values["diff-file"];
  const diff = diffFile === undefined ? undefined : await readFile(diffFile, "utf8");

  const config = loadConfig(io.configDeps());
  const driver = io.makeDriver(config);
  try {
    const result = await deliberate(
      {
        mode,
        question,
        ...(values.option && { options: values.option }),
        ...(values.notes !== undefined && { notes: values.notes }),
        ...(values.file && { files: values.file }),
        ...(maxRounds !== undefined && { maxRounds }),
        ...(diff !== undefined && { diff }),
      },
      {
        config,
        driver,
        runId: defaultRunId(),
        emit: progressPrinter(io),
        ...(io.signal && { signal: io.signal }),
      },
    );
    io.stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.report}\n`);
    return result.status === "failed" ? 1 : 0;
  } finally {
    await driver.dispose();
  }
}

/** Прогресс в stderr: stdout остаётся для итога (и для JSON). */
function progressPrinter(io: CliIO): (event: CouncilEvent) => void {
  return (event) => {
    switch (event.type) {
      case "run_started":
        io.stderr(
          `🏛 Council · ${event.mode} · run ${event.runId} · участники ${event.aliases.join(", ")}\n`,
        );
        break;
      case "round_started":
        io.stderr(
          `   раунд ${event.round}: ${event.aliases.map((a) => `${markerFor(a)} ${a}`).join(" ")} …\n`,
        );
        break;
      case "participant_done":
        io.stderr(
          `   ${markerFor(event.alias)} ${event.alias} ✓ ${formatDuration(event.durationMs)}\n`,
        );
        break;
      case "participant_retry":
        io.stderr(`   ${markerFor(event.alias)} ${event.alias} ⚠ ретрай (${event.reason})\n`);
        break;
      case "participant_failed":
        io.stderr(`   ${markerFor(event.alias)} ${event.alias} ✗ ${event.reason}\n`);
        break;
      case "round_finished":
      case "run_finished":
        break;
    }
  };
}

async function doctor(io: CliIO): Promise<number> {
  const config = loadConfig(io.configDeps());
  const state = { ok: true };
  const line = (good: boolean, text: string) => {
    if (!good) state.ok = false;
    io.stdout(`${good ? "✓" : "✗"} ${text}\n`);
  };
  line(
    true,
    `конфиг: ${config.configPath ?? "только env"} · модели: ${config.models.map((m) => m.id).join(", ")}`,
  );

  const probe = await probeEndpoint(config, io.fetch ?? fetch);
  if (!probe.ok) {
    line(false, `эндпоинт ${config.endpoint.baseUrl}: ${probe.error}`);
  } else {
    line(true, `эндпоинт ${config.endpoint.baseUrl}: доступен, моделей ${probe.models.length}`);
    for (const m of config.models) {
      const found = probe.models.find((p) => p.id === m.id);
      const ctx =
        found?.context !== undefined
          ? ` · контекст ${String(found.context)} (в конфиге ${String(m.context)})`
          : "";
      line(found !== undefined, `модель ${m.id}${found ? ctx : ": нет в списке /models"}`);
    }
  }

  try {
    const driver = io.makeDriver(config);
    const detail = io.describeAgent ? await io.describeAgent(config) : "";
    line(true, `участники: ${driver.name}${detail ? ` · ${detail}` : ""}`);
    await driver.dispose();
  } catch (e) {
    line(false, `участники: ${(e as Error).message}`);
  }
  return state.ok ? 0 : 1;
}

function isUsageError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    ((error as NodeJS.ErrnoException).code ?? "").startsWith("ERR_PARSE_ARGS_")
  );
}
