import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  ConfigError,
  describeConfig,
  loadConfig,
  type ConfigDeps,
  type CouncilConfig,
  type PanelSize,
  type Style,
} from "../core/config.js";
import {
  BudgetError,
  deliberate,
  InputError,
  planRun,
  type DeliberateInput,
} from "../core/deliberate.js";
import { renderEstimate } from "../core/estimate.js";
import { seatsPerModel } from "../core/panel.js";
import { renderDoctor, runDoctor, type Check } from "../core/doctor.js";
import { route } from "../core/router.js";
import { collectUsage, renderUsage } from "../core/usage.js";
import { HOSTS, renderSetup, runSetup, type Host } from "./setup.js";
import type { CouncilEvent } from "../core/events.js";
import { defaultRunId } from "../core/jobs.js";
import { formatDuration, markerFor } from "../core/output/format.js";
import type { ParticipantDriver } from "../core/participant.js";
import type { Goal, Mode } from "../core/types.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configDeps: () => ConfigDeps;
  /** Драйвер участников; в тестах — фейк. Бросает ProfileError, если агент не найден. */
  makeDriver: (config: CouncilConfig) => ParticipantDriver;
  /** Проверка агента-участника для doctor. */
  checkAgent?: (config: CouncilConfig) => Promise<Check[]>;
  which?: (command: string) => string | undefined;
  /** Абсолютный путь к бандлу — для команды MCP-сервера в setup. */
  bundlePath?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  debug: boolean;
}

const HELP = `council — совет моделей для архитектурных решений

Использование:
  council run [--mode consensus|debate|vote|review] --question "<вопрос>" [--notes "<ограничения>"] [--file <путь>]...
              [--option A --option B] [--panel 3|5|7] [--goal advice|decision|plan|implement|review]
              [--style balanced|adversarial|red-team|executive|implementation] [--research-first]
              [--max-rounds N] [--diff-file <путь>] [--criterion "…"]... [--swap-sides]
              [--budget-calls N] [--budget-tokens N]
              [--confirm-budget] [--dry-run] [--no-adr] [--adr-title "…"] [--json]
  council mcp [--http [--host 127.0.0.1] [--port 8765]] [--wait-s 45]
                      MCP-сервер (stdio по умолчанию; логи в stderr)
  council setup [--host opencode|dsh|claude|all] [--force]
                      подготовить проект: команды, агенты, Skill, AGENTS.md, конфиг, .gitignore
  council doctor      проверить конфиг, эндпоинт, модели, агента-участника, права, окружение
  council usage [--days N] [--json]
                      фактический расход по моделям, режимам, персонам и дням
  council route "<запрос>"
                      какую команду совета выбрать для запроса
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
      case "setup":
        return await setup(rest, io);
      case "usage":
        return await usage(rest, io);
      case "route": {
        const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true });
        io.stdout(`${JSON.stringify(route(positionals.join(" ")), null, 2)}\n`);
        return 0;
      }
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

const intArg = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InputError(`--${name}: целое неотрицательное число`);
  return n;
};

async function run(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      mode: { type: "string", default: "consensus" },
      question: { type: "string", short: "q" },
      option: { type: "string", multiple: true },
      notes: { type: "string" },
      file: { type: "string", multiple: true },
      "max-rounds": { type: "string" },
      "diff-file": { type: "string" },
      panel: { type: "string" },
      goal: { type: "string" },
      style: { type: "string" },
      "research-first": { type: "boolean", default: false },
      criterion: { type: "string", multiple: true },
      "swap-sides": { type: "boolean", default: false },
      "budget-calls": { type: "string" },
      "budget-tokens": { type: "string" },
      "confirm-budget": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "no-adr": { type: "boolean", default: false },
      "adr-title": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const mode = values.mode as Mode;
  if (!MODES.includes(mode)) throw new InputError(`--mode: ожидается ${MODES.join(" | ")}`);
  const question = values.question ?? positionals.join(" ");
  if (!question.trim()) throw new InputError('нужен вопрос: --question "…"');

  const maxRounds = intArg("max-rounds", values["max-rounds"]);
  const panel = intArg("panel", values.panel);
  const maxCalls = intArg("budget-calls", values["budget-calls"]);
  const maxTokens = intArg("budget-tokens", values["budget-tokens"]);
  const diffFile = values["diff-file"];
  const diff = diffFile === undefined ? undefined : await readFile(diffFile, "utf8");

  const input: DeliberateInput = {
    mode,
    question,
    ...(values.option && { options: values.option }),
    ...(values.notes !== undefined && { notes: values.notes }),
    ...(values.file && { files: values.file }),
    ...(maxRounds !== undefined && { maxRounds }),
    ...(diff !== undefined && { diff }),
    ...(panel !== undefined && { panel: panel as PanelSize }),
    ...(values.goal !== undefined && { goal: values.goal as Goal }),
    ...(values.style !== undefined && { style: values.style as Style }),
    ...(values["research-first"] && { researchFirst: true }),
    ...(values.criterion && { criteria: values.criterion }),
    ...(values["swap-sides"] && { swapSides: true }),
    ...((maxCalls !== undefined || maxTokens !== undefined) && { budget: { maxCalls, maxTokens } }),
    ...(values["confirm-budget"] && { confirmBudget: true }),
    ...(values["no-adr"] && { writeAdr: false }),
    ...(values["adr-title"] !== undefined && { adrTitle: values["adr-title"] }),
  };

  const config = loadConfig(io.configDeps());
  const runId = defaultRunId();
  if (values["dry-run"]) {
    const plan = await planRun(input, config, runId);
    if (values.json) {
      io.stdout(
        `${JSON.stringify({ dry_run: true, estimate: plan.estimate, over_budget: plan.overBudget, panel: plan.seats.map((s) => s.persona.id) }, null, 2)}\n`,
      );
    } else {
      const perModel = [...seatsPerModel(plan.seats).values()];
      io.stdout(
        [
          `🏛 Council · ${mode} · dry run (модели не вызываются)`,
          `Панель (${String(plan.seats.length)}): ${plan.seats.map((s) => s.persona.name).join(", ")}`,
          `Мест на модель: ${perModel.join(" / ")} · goal ${plan.goal} · style ${plan.style} · max_rounds ${String(plan.maxRounds)}`,
          renderEstimate(plan.estimate),
          ...(plan.overBudget.length > 0
            ? [`⚠ Превышение бюджета: ${plan.overBudget.join("; ")}`]
            : []),
        ].join("\n") + "\n",
      );
    }
    return 0;
  }

  const driver = io.makeDriver(config);
  try {
    const result = await deliberate(input, {
      config,
      driver,
      runId,
      emit: progressPrinter(io),
      ...(io.signal && { signal: io.signal }),
    });
    io.stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.report}\n`);
    return result.status === "failed" ? 1 : 0;
  } catch (e) {
    if (e instanceof BudgetError) {
      io.stderr(
        `council: ${e.message}\nПовторите с --confirm-budget, чтобы запустить всё равно.\n`,
      );
      return 3;
    }
    throw e;
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
  const checks = await runDoctor(config, {
    ...(io.fetch && { fetch: io.fetch }),
    checkAgent: io.checkAgent ?? (() => Promise.resolve([])),
    which: io.which ?? (() => undefined),
  });
  io.stdout(`${renderDoctor(checks)}\n`);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

async function setup(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      host: { type: "string", multiple: true },
      force: { type: "boolean", default: false },
    },
  });
  const requested = values.host ?? ["opencode"];
  const hosts = requested.includes("all") ? [...HOSTS] : requested;
  const bad = hosts.filter((h) => !(HOSTS as readonly string[]).includes(h));
  if (bad.length > 0) throw new InputError(`--host: ${HOSTS.join(" | ")} | all`);
  const deps = io.configDeps();
  const workspace = resolve(deps.cwd, deps.env.COUNCIL_WORKSPACE ?? ".");
  const models = deps.env.COUNCIL_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const result = await runSetup({
    workspace,
    hosts: hosts as Host[],
    force: values.force,
    bundlePath: io.bundlePath ?? "council",
    ...(models && { models }),
  });
  io.stdout(`${renderSetup(result)}\n`);
  try {
    loadConfig(deps);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.stdout(`\n${e.message}\n`);
      return 0;
    }
    throw e;
  }
  io.stdout("\n");
  return doctor(io);
}

async function usage(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { days: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const config = loadConfig(io.configDeps());
  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isInteger(days) || days <= 0))
    throw new InputError("--days: целое положительное число");
  const report = await collectUsage(
    config.paths.stateDir,
    days === undefined ? {} : { sinceDays: days },
  );
  io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderUsage(report)}\n`);
  return 0;
}

function isUsageError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    ((error as NodeJS.ErrnoException).code ?? "").startsWith("ERR_PARSE_ARGS_")
  );
}
