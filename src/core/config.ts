import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { z } from "zod";

import { Secret } from "./secret.js";

/**
 * Конфигурация совета: переменные окружения + необязательный `council.config.json`.
 * Приоритет: значения по умолчанию < файл < env. Секреты — только из env.
 */

export const PANEL_SIZES = [3, 5, 7] as const;
export const STYLES = [
  "balanced",
  "adversarial",
  "red-team",
  "executive",
  "implementation",
] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export const AGENTS = ["auto", "opencode", "dsh", "custom"] as const;
export const LANGUAGES = ["ru", "en"] as const;
export const AUTO_ROUTER_MODES = ["off", "suggest", "invoke"] as const;
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type PanelSize = (typeof PANEL_SIZES)[number];
export type Style = (typeof STYLES)[number];
export type Effort = (typeof EFFORTS)[number];
export type AgentKind = (typeof AGENTS)[number];

export const DEFAULT_PROTECTED_PATHS = [
  "**/migrations/**",
  "**/*.sql",
  "**/openapi*.{yml,yaml,json}",
  "docs/architecture/**",
];

const MODEL_DEFAULTS = { context: 32_000, output: 8_000, maxConcurrency: 1 } as const;
const MIN_MODELS = 2;

const ratio = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();

const ModelFileSchema = z
  .object({
    id: z.string().trim().min(1),
    effort: z.enum(EFFORTS).optional(),
    reasoningField: z.string().trim().min(1).optional(),
    context: positiveInt.optional(),
    output: positiveInt.optional(),
    maxConcurrency: z.number().int().min(1).max(8).optional(),
  })
  .strict();

const ParticipantFileSchema = z
  .object({
    agent: z.enum(AGENTS).optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    roundTimeoutS: positiveInt.optional(),
  })
  .strict();

const BudgetSchema = z
  .object({
    maxCalls: positiveInt.optional(),
    maxTokens: positiveInt.optional(),
    maxDurationS: positiveInt.optional(),
  })
  .strict();

const DefaultsFileSchema = z
  .object({
    panel: z
      .union([z.literal(3), z.literal(5), z.literal(7)], { error: "ожидается 3, 5 или 7" })
      .optional(),
    style: z.enum(STYLES).optional(),
    maxRounds: z.number().int().min(1).max(5).optional(),
    majorityThreshold: ratio.optional(),
    qualityThreshold: ratio.optional(),
    budget: BudgetSchema.optional(),
  })
  .strict();

const PathsFileSchema = z
  .object({
    adrDir: z.string().min(1).optional(),
    stateDir: z.string().min(1).optional(),
  })
  .strict();

export const ConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    language: z.enum(LANGUAGES).optional(),
    models: z.array(ModelFileSchema).optional(),
    chair: z.string().trim().min(1).optional(),
    participant: ParticipantFileSchema.optional(),
    defaults: DefaultsFileSchema.optional(),
    paths: PathsFileSchema.optional(),
    protectedPaths: z.array(z.string().min(1)).optional(),
    personas: z
      .record(
        z.string(),
        z
          .object({
            name: z.string().trim().min(1).max(100).optional(),
            short: z.string().trim().min(1).max(40).optional(),
            focus: z.string().trim().min(1).max(600).optional(),
            vetoPower: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

const EnvSchema = z.object({
  COUNCIL_BASE_URL: z.url({ protocol: /^https?$/, error: "нужен URL вида https://host/v1" }),
  COUNCIL_API_KEY: z.string().min(1, "переменная пуста"),
  COUNCIL_MODELS: z.string().optional(),
  COUNCIL_WORKSPACE: z.string().min(1).optional(),
  COUNCIL_CONFIG: z.string().min(1).optional(),
  COUNCIL_AGENT: z.enum(AGENTS).optional(),
  COUNCIL_QUALITY_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
  COUNCIL_GUARD: z.enum(["on", "off"]).optional(),
  COUNCIL_AUTO_ROUTER: z.enum(AUTO_ROUTER_MODES).optional(),
  COUNCIL_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});

export interface ModelConfig {
  /** Идентификатор модели у провайдера. В промпты не попадает. */
  id: string;
  effort?: Effort;
  reasoningField?: string;
  context: number;
  output: number;
  maxConcurrency: number;
}

export interface CouncilConfig {
  workspace: string;
  /** Путь к прочитанному council.config.json, если он был. */
  configPath?: string;
  endpoint: { baseUrl: string; apiKey: Secret };
  models: ModelConfig[];
  chair?: string;
  participant: {
    agent: AgentKind;
    command?: string[];
    env: Record<string, string>;
    roundTimeoutS: number;
  };
  language: (typeof LANGUAGES)[number];
  defaults: {
    panel: PanelSize;
    style: Style;
    maxRounds: number;
    majorityThreshold: number;
    qualityThreshold: number;
    budget: z.infer<typeof BudgetSchema>;
  };
  /** Абсолютные пути внутри workspace. */
  paths: { adrDir: string; stateDir: string };
  protectedPaths: string[];
  /** Переопределения персон (имя, фокус, право вето) по id из каталога. */
  personas: Record<
    string,
    {
      name?: string | undefined;
      short?: string | undefined;
      focus?: string | undefined;
      vetoPower?: boolean | undefined;
    }
  >;
  guard: boolean;
  autoRouter: (typeof AUTO_ROUTER_MODES)[number];
  logLevel: (typeof LOG_LEVELS)[number];
}

/** Ошибка конфигурации: список понятных человеку проблем, без stacktrace в CLI. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(["Ошибка конфигурации council-mcp:", ...issues.map((i) => `  - ${i}`)].join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface ConfigDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  /** Возвращает содержимое файла или undefined, если файла нет. */
  readFile: (path: string) => string | undefined;
}

export const nodeConfigDeps = (): ConfigDeps => ({
  env: process.env,
  cwd: process.cwd(),
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
});

const SECRET_KEY = /(api[-_]?key|token|secret|passw(or)?d|credential)/i;

const ENV_HINTS: Record<string, string> = {
  COUNCIL_BASE_URL: "адрес OpenAI-совместимого эндпоинта",
  COUNCIL_API_KEY: "ключ доступа к эндпоинту",
};

const zodLocale = z.locales.ru();

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path
      ? `${prefix}${path}: ${issue.message}`
      : `${prefix.replace(/\s$/, "")} ${issue.message}`;
  });
}

function findSecretKeys(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findSecretKeys(v, [...path, String(i)]));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => {
      const here = [...path, key];
      return SECRET_KEY.test(key) ? [here.join(".")] : findSecretKeys(v, here);
    });
  }
  return [];
}

/** Путь из конфига → абсолютный путь, не выходящий за пределы workspace. */
function insideWorkspace(
  workspace: string,
  value: string,
  field: string,
  issues: string[],
): string {
  const abs = resolve(workspace, value);
  const rel = relative(workspace, abs);
  if (isAbsolute(value) || rel.startsWith("..") || isAbsolute(rel)) {
    issues.push(`${field}: путь «${value}» должен быть относительным и внутри COUNCIL_WORKSPACE`);
  }
  return normalize(abs);
}

function parseModelList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseConfigFile(
  path: string,
  text: string | undefined,
  explicit: boolean,
  issues: string[],
): ConfigFile | undefined {
  if (text === undefined) {
    if (explicit) issues.push(`COUNCIL_CONFIG: файл не найден: ${path}`);
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    issues.push(`${path}: некорректный JSON (${(e as Error).message})`);
    return undefined;
  }
  const secrets = findSecretKeys(data);
  if (secrets.length > 0) {
    issues.push(
      `${path}: секреты в файле запрещены (${secrets.join(", ")}). Передавайте их через переменные окружения.`,
    );
    return undefined;
  }
  const parsed = ConfigFileSchema.safeParse(data, { error: zodLocale.localeError });
  if (!parsed.success) {
    issues.push(...formatIssues(`${path}: `, parsed.error));
    return undefined;
  }
  return parsed.data;
}

/**
 * Собирает и валидирует конфигурацию. Бросает ConfigError со всеми найденными проблемами сразу.
 */
export function loadConfig(deps: ConfigDeps = nodeConfigDeps()): CouncilConfig {
  const issues: string[] = [];

  const envParsed = EnvSchema.safeParse(deps.env, { error: zodLocale.localeError });
  if (!envParsed.success) {
    for (const issue of envParsed.error.issues) {
      const name = issue.path.map(String).join(".");
      const missing = deps.env[name] === undefined;
      const hint = ENV_HINTS[name];
      issues.push(
        missing ? `${name}: не задана${hint ? ` (${hint})` : ""}` : `${name}: ${issue.message}`,
      );
    }
  }
  const env = envParsed.success ? envParsed.data : undefined;

  const workspace = resolve(deps.cwd, deps.env.COUNCIL_WORKSPACE ?? ".");
  const explicitPath = deps.env.COUNCIL_CONFIG;
  const configPath = resolve(workspace, explicitPath ?? "council.config.json");
  const fileText = deps.readFile(configPath);
  const file = parseConfigFile(configPath, fileText, explicitPath !== undefined, issues) ?? {};

  // Состав моделей: COUNCIL_MODELS выбирает модели и порядок, файл задаёт их параметры.
  const fileModels = new Map((file.models ?? []).map((m) => [m.id, m]));
  // «COUNCIL_MODELS=a,b» вместо «a,b» — частая ошибка при переносе из shell в конфиг.
  const rawModels = deps.env.COUNCIL_MODELS?.replace(/^\s*COUNCIL_MODELS\s*=\s*/, "");
  const ids = rawModels !== undefined ? parseModelList(rawModels) : [...fileModels.keys()];
  for (const id of ids) {
    if (/[\s=]/.test(id))
      issues.push(
        `COUNCIL_MODELS: недопустимое имя модели «${id}» (пробелы или «=») — укажите имена так, как их называет эндпоинт`,
      );
  }
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    issues.push(`COUNCIL_MODELS: модели повторяются: ${[...new Set(duplicates)].join(", ")}`);
  }
  if (ids.length < MIN_MODELS) {
    issues.push(
      ids.length === 0
        ? "COUNCIL_MODELS: не задана (нужно минимум две модели через запятую, например model-a,model-b)"
        : `COUNCIL_MODELS: нужно минимум ${MIN_MODELS} модели, указано ${ids.length}`,
    );
  }
  const models: ModelConfig[] = ids.map((id) => {
    const m = fileModels.get(id);
    return {
      id,
      ...(m?.effort !== undefined && { effort: m.effort }),
      ...(m?.reasoningField !== undefined && { reasoningField: m.reasoningField }),
      context: m?.context ?? MODEL_DEFAULTS.context,
      output: m?.output ?? MODEL_DEFAULTS.output,
      maxConcurrency: m?.maxConcurrency ?? MODEL_DEFAULTS.maxConcurrency,
    };
  });

  if (file.chair !== undefined && !ids.includes(file.chair)) {
    issues.push(`chair: модель «${file.chair}» не входит в состав совета (${ids.join(", ")})`);
  }

  const agent = env?.COUNCIL_AGENT ?? file.participant?.agent ?? "auto";
  if (agent === "custom" && file.participant?.command === undefined) {
    issues.push('participant.command: обязателен при agent = "custom"');
  }

  const paths = {
    adrDir: insideWorkspace(workspace, file.paths?.adrDir ?? "docs/adr", "paths.adrDir", issues),
    stateDir: insideWorkspace(
      workspace,
      file.paths?.stateDir ?? ".council",
      "paths.stateDir",
      issues,
    ),
  };

  if (issues.length > 0 || env === undefined) {
    throw new ConfigError(issues);
  }

  return {
    workspace,
    ...(fileText !== undefined && { configPath }),
    endpoint: { baseUrl: env.COUNCIL_BASE_URL, apiKey: new Secret(env.COUNCIL_API_KEY) },
    models,
    ...(file.chair !== undefined && { chair: file.chair }),
    participant: {
      agent,
      ...(file.participant?.command !== undefined && { command: file.participant.command }),
      env: file.participant?.env ?? {},
      roundTimeoutS: file.participant?.roundTimeoutS ?? 900,
    },
    language: file.language ?? "ru",
    defaults: {
      panel: file.defaults?.panel ?? 3,
      style: file.defaults?.style ?? "balanced",
      maxRounds: file.defaults?.maxRounds ?? 2,
      majorityThreshold: file.defaults?.majorityThreshold ?? 0.7,
      qualityThreshold: env.COUNCIL_QUALITY_THRESHOLD ?? file.defaults?.qualityThreshold ?? 0.75,
      budget: file.defaults?.budget ?? {},
    },
    paths,
    protectedPaths: file.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    personas: file.personas ?? {},
    guard: env.COUNCIL_GUARD !== "off",
    autoRouter: env.COUNCIL_AUTO_ROUTER ?? "invoke",
    logLevel: env.COUNCIL_LOG_LEVEL ?? "info",
  };
}

/** Конфиг без секретов — для council_info, doctor и логов. */
export function describeConfig(config: CouncilConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}
