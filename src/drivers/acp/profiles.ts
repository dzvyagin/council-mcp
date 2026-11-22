import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { CouncilConfig, ModelConfig } from "../../core/config.js";

/**
 * Профили ACP-агентов. council-mcp не содержит агента: он запускает уже установленный
 * у пользователя (`opencode acp` и т. п.) с изолированным окружением и правами только на чтение.
 */

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** ACP session/set_config_option после создания сессии (например, выбор модели). */
  configOptions: { configId: string; value: string }[];
  cleanup: () => Promise<void>;
}

export interface AgentProfile {
  readonly kind: "opencode" | "custom";
  /** Для отчётов и doctor. */
  readonly label: string;
  launch(model: ModelConfig, config: CouncilConfig): Promise<LaunchSpec>;
}

/** Переменные окружения, которые нужны агенту для сети и локали; всё остальное не передаётся. */
const PASSTHROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
];

export function baseEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Ищет исполняемый файл в PATH (без зависимостей и без запуска оболочки). */
export function which(command: string, path = process.env.PATH ?? ""): string | undefined {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // нет в этой папке
      }
    }
  }
  return undefined;
}

// --- opencode V2 -----------------------------------------------------------------------------

const PROVIDER = "council";
const MODEL_KEY = "m";
const KEY_ENV = "COUNCIL_PROVIDER_API_KEY";
export const EXPLORE_AGENT = "council-explore";

const rule = (action: string, resource: string, effect: "allow" | "deny") => ({
  action,
  resource,
  effect,
});

/** Пути, которые участник не читает: секреты и служебные файлы совета. */
const SECRET_PATHS = [
  ".env",
  ".env.*",
  "*/.env",
  "*/.env.*",
  "*.pem",
  "*.key",
  "*id_rsa*",
  "*id_ed25519*",
  ".council/*",
  ".git/*",
];

/** Имя MCP-сервера ответов в session/new: инструменты видны как council_<tool>. */
export const ANSWER_SERVER = "council";

/**
 * Права (V2 `permissions`, побеждает последнее совпадение): запрещено всё, кроме чтения и поиска
 * внутри проекта. Участнику дополнительно разрешены свой read-only субагент и инструменты ответа
 * совета; субагенту и служебным агентам — нет (ответ сдаёт только сам участник).
 * Правило deny на `execute` (Code Mode) входит в общий запрет: MCP-инструменты видны напрямую.
 */
export function readOnlyRules(role: "participant" | "helper") {
  return [
    rule("*", "*", "deny"),
    rule("read", "*", "allow"),
    rule("glob", "*", "allow"),
    rule("grep", "*", "allow"),
    ...SECRET_PATHS.map((p) => rule("read", p, "deny")),
    rule("external_directory", "*", "deny"),
    ...(role === "participant"
      ? [rule("subagent", EXPLORE_AGENT, "allow"), rule(`${ANSWER_SERVER}_*`, "*", "allow")]
      : []),
  ];
}

export function opencodeConfig(model: ModelConfig, config: CouncilConfig): Record<string, unknown> {
  const modelEntry: Record<string, unknown> = {
    modelID: model.id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: model.context, output: model.output },
  };
  if (model.reasoningField) modelEntry.compatibility = { reasoningField: model.reasoningField };
  if (model.effort) modelEntry.settings = { reasoningEffort: model.effort };

  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER}/${MODEL_KEY}`,
    default_agent: "councillor",
    update: "disable",
    share: "disabled",
    providers: {
      [PROVIDER]: {
        name: "Council",
        env: [KEY_ENV],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: config.endpoint.baseUrl },
        models: { [MODEL_KEY]: modelEntry },
      },
    },
    permissions: readOnlyRules("helper"),
    agents: {
      councillor: {
        mode: "primary",
        description:
          "Участник совета: исследует проект только на чтение и сдаёт ответ инструментом",
        permissions: readOnlyRules("participant"),
      },
      // Генерация заголовка сессии — лишний вызов модели на каждого участника.
      title: { disabled: true },
      [EXPLORE_AGENT]: {
        mode: "subagent",
        description: "Read-only поиск и чтение кода проекта по поручению участника совета",
        permissions: readOnlyRules("helper"),
      },
    },
  };
}

export const opencodeProfile = (command: string): AgentProfile => ({
  kind: "opencode",
  label: "opencode acp",
  async launch(model, config) {
    // Своя папка на участника: конфиг, база и кэш opencode не пересекаются ни с пользователем,
    // ни с другими участниками; проектный конфиг не может ослабить права.
    const home = await mkdtemp(join(tmpdir(), "council-oc-"));
    const env: Record<string, string> = {
      ...baseEnv(process.env),
      ...config.participant.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      OPENCODE_CONFIG_DIR: join(home, "opencode"),
      OPENCODE_DB: ":memory:",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(model, config)),
      [KEY_ENV]: config.endpoint.apiKey.reveal(),
    };
    return {
      command,
      args: ["acp"],
      env,
      configOptions: [],
      cleanup: () => rm(home, { recursive: true, force: true }),
    };
  },
});

// --- произвольный ACP-агент --------------------------------------------------------------------

/**
 * Любой ACP-агент из `participant.command`. Агент сам отвечает за свою изоляцию; council-mcp
 * передаёт параметры модели через env и пытается выбрать модель через session/set_config_option.
 */
export const customProfile = (command: string[]): AgentProfile => {
  const [bin, ...args] = command;
  if (bin === undefined) throw new Error("participant.command пуст");
  return {
    kind: "custom",
    label: command.join(" "),
    launch(model, config) {
      return Promise.resolve({
        command: bin,
        args,
        env: {
          ...baseEnv(process.env),
          ...config.participant.env,
          COUNCIL_BASE_URL: config.endpoint.baseUrl,
          COUNCIL_API_KEY: config.endpoint.apiKey.reveal(),
          COUNCIL_PARTICIPANT_MODEL: model.id,
          ...(model.effort !== undefined && { COUNCIL_PARTICIPANT_EFFORT: model.effort }),
        },
        configOptions: [{ configId: "model", value: model.id }],
        cleanup: () => Promise.resolve(),
      });
    },
  };
};

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** Выбирает профиль по конфигу и тому, что установлено у пользователя. */
export function resolveProfile(config: CouncilConfig, find = which): AgentProfile {
  const { agent, command } = config.participant;
  if (agent === "custom") {
    if (!command) throw new ProfileError('participant.command обязателен при agent = "custom"');
    return customProfile(command);
  }
  if (agent === "dsh") {
    throw new ProfileError(
      "профиль DeepSeek Harness появится в фазе 9; сейчас используйте opencode или agent = custom с командой dsh",
    );
  }
  const opencode = find("opencode");
  if (opencode) return opencodeProfile(opencode);
  throw new ProfileError(
    agent === "opencode"
      ? "opencode не найден в PATH: установите opencode V2 (npm i -g @opencode/cli) или укажите participant.command"
      : "не найден ACP-агент для участников: установите opencode V2 (npm i -g @opencode/cli) или задайте participant.agent = custom и participant.command",
  );
}
