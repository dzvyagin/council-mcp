import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { TEMPLATES } from "./templates.generated.js";

/**
 * `council setup` — подготовка проекта: команды и агенты opencode, Skill, фрагмент AGENTS.md,
 * council.config.json, `.council/` в .gitignore, MCP-конфиг хоста. Существующие файлы
 * без --force не перезаписываются; чужой opencode.json(c) не редактируется — выводится блок.
 * Секреты в файлы не пишутся: только ссылки {env:...}.
 */

export const HOSTS = ["opencode", "dsh", "claude"] as const;
export type Host = (typeof HOSTS)[number];

export interface SetupOptions {
  workspace: string;
  hosts: Host[];
  force: boolean;
  /** Абсолютный путь к бандлу council (для команды MCP-сервера). */
  bundlePath: string;
  /** Модели для council.config.json (из COUNCIL_MODELS), если файла ещё нет. */
  models?: string[];
}

export interface SetupResult {
  created: string[];
  updated: string[];
  skipped: string[];
  notes: string[];
}

const AGENTS_MARKER = "## Совет моделей";

export function mcpServerBlock(bundlePath: string): Record<string, unknown> {
  return {
    type: "local",
    command: ["node", bundlePath, "mcp"],
    environment: {
      COUNCIL_BASE_URL: "{env:COUNCIL_BASE_URL}",
      COUNCIL_API_KEY: "{env:COUNCIL_API_KEY}",
      COUNCIL_MODELS: "{env:COUNCIL_MODELS}",
      COUNCIL_WORKSPACE: ".",
      COUNCIL_WAIT_S: "45",
    },
    codemode: false,
  };
}

export async function runSetup(o: SetupOptions): Promise<SetupResult> {
  const r: SetupResult = { created: [], updated: [], skipped: [], notes: [] };
  const put = async (rel: string, content: string) => {
    const path = join(o.workspace, rel);
    if (existsSync(path) && !o.force) {
      r.skipped.push(rel);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    const existed = existsSync(path);
    await writeFile(path, content, "utf8");
    (existed ? r.updated : r.created).push(rel);
  };
  const template = (name: string): string => {
    const t = TEMPLATES[name];
    if (t === undefined) throw new Error(`нет шаблона ${name}`);
    return t;
  };

  // Skill — общий для всех хостов (.agents/skills — opencode, DSH, Codex, deepagents).
  await put(".agents/skills/council/SKILL.md", template("skills/council/SKILL.md"));

  if (o.hosts.includes("opencode")) {
    for (const name of Object.keys(TEMPLATES).filter(
      (n) => n.startsWith("opencode/commands/") || n.startsWith("opencode/agents/"),
    )) {
      await put(`.opencode/${name.slice("opencode/".length)}`, template(name));
    }
    // Плагин: защита путей, сводка процесса, подсказка роутера; логика — в dist/plugin/lib.js.
    const lib = pathToFileURL(join(dirname(o.bundlePath), "..", "plugin", "lib.js")).href;
    await put(
      ".opencode/plugins/council.ts",
      template("opencode/plugins/council.ts").replace("__COUNCIL_PLUGIN_LIB__", lib),
    );
    const configs = ["opencode.jsonc", "opencode.json"].filter((f) =>
      existsSync(join(o.workspace, f)),
    );
    const block = mcpServerBlock(o.bundlePath);
    if (configs.length === 0) {
      await put(
        "opencode.jsonc",
        `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers: { council: block } } }, null, 2)}\n`,
      );
    } else {
      const text = await readFile(join(o.workspace, configs[0] as string), "utf8");
      if (/"council"\s*:/.test(text)) {
        r.skipped.push(`${configs[0] as string} (council уже настроен)`);
      } else {
        r.notes.push(
          `Добавьте в ${configs[0] as string} в "mcp": { "servers": { … } } блок:\n"council": ${JSON.stringify(block, null, 2)}`,
        );
      }
    }
  }

  if (o.hosts.includes("claude")) {
    await put(".claude/skills/council/SKILL.md", template("skills/council/SKILL.md"));
    const mcpJson = join(o.workspace, ".mcp.json");
    const server = {
      command: "node",
      args: [o.bundlePath, "mcp"],
      env: { COUNCIL_WORKSPACE: "." },
    };
    if (!existsSync(mcpJson)) {
      await put(".mcp.json", `${JSON.stringify({ mcpServers: { council: server } }, null, 2)}\n`);
    } else if (!(await readFile(mcpJson, "utf8")).includes('"council"')) {
      r.notes.push(`Добавьте в .mcp.json в "mcpServers": "council": ${JSON.stringify(server)}`);
    }
  }

  if (o.hosts.includes("dsh")) {
    r.notes.push(
      [
        "DeepSeek Harness: добавьте запись в конфигурацию (YAML):",
        "- id: mcp-council",
        "  name: '@deepseek-ai/dsh-mcp-client'",
        "  config:",
        "    serverName: council",
        "    transport: stdio",
        "    command: node",
        `    args: ['${o.bundlePath}', 'mcp']`,
        "    env:",
        "      COUNCIL_BASE_URL: !!js process.env.COUNCIL_BASE_URL",
        "      COUNCIL_API_KEY: !!js process.env.COUNCIL_API_KEY",
        "      COUNCIL_MODELS: !!js process.env.COUNCIL_MODELS",
        "      COUNCIL_AGENT: opencode",
        "      COUNCIL_WAIT_S: '45'",
      ].join("\n"),
    );
  }

  // AGENTS.md: фрагмент с правилами вызова совета.
  const agentsMd = join(o.workspace, "AGENTS.md");
  const fragment = template("opencode/AGENTS.fragment.md");
  if (!existsSync(agentsMd)) {
    await put("AGENTS.md", fragment);
  } else if (!(await readFile(agentsMd, "utf8")).includes(AGENTS_MARKER)) {
    await appendFile(agentsMd, `\n${fragment}`);
    r.updated.push("AGENTS.md");
  } else {
    r.skipped.push("AGENTS.md (фрагмент уже есть)");
  }

  // council.config.json — без секретов.
  if (!existsSync(join(o.workspace, "council.config.json"))) {
    const config = {
      language: "ru",
      ...(o.models && o.models.length > 0 && { models: o.models.map((id) => ({ id })) }),
      participant: { agent: "auto" },
      paths: { adrDir: "docs/adr", stateDir: ".council" },
    };
    await put("council.config.json", `${JSON.stringify(config, null, 2)}\n`);
  } else {
    r.skipped.push("council.config.json");
  }

  // .council/ — вне git.
  const gitignore = join(o.workspace, ".gitignore");
  const ignoreText = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
  if (!ignoreText.split(/\r?\n/).some((l) => /^\/?\.council\/?$/.test(l.trim()))) {
    await appendFile(
      gitignore,
      `${ignoreText === "" || ignoreText.endsWith("\n") ? "" : "\n"}.council/\n`,
    );
    (ignoreText === "" ? r.created : r.updated).push(".gitignore");
  }
  return r;
}

export function renderSetup(r: SetupResult): string {
  const list = (title: string, items: string[]) =>
    items.length > 0 ? [`${title}:`, ...items.map((i) => `  - ${i}`)] : [];
  return [
    "🏛 Council · setup",
    ...list("Создано", r.created),
    ...list("Обновлено", r.updated),
    ...list("Пропущено (уже есть; --force — перезаписать)", r.skipped),
    ...r.notes.map((n) => `\n${n}`),
    "",
    "Дальше: задайте COUNCIL_BASE_URL, COUNCIL_API_KEY, COUNCIL_MODELS в окружении и перезапустите хост; проверка — council doctor.",
  ].join("\n");
}
