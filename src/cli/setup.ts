import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { TEMPLATES } from "./templates.generated.js";

/**
 * `council setup` — подготовка проекта для хостов без плагина (Claude Code, DSH): Skill,
 * council.config.json, `.council/` в .gitignore, MCP-конфиг хоста. Существующие файлы
 * без --force не перезаписываются; чужой .mcp.json не редактируется — выводится блок.
 * Для opencode — подсказка про плагин. Секреты в файлы не пишутся.
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

  if (o.hosts.includes("opencode")) {
    // opencode: всё ставит плагин, один раз на машину — в проект ничего не пишем.
    r.notes.push(
      [
        "opencode: поставьте плагин совета один раз на машину (MCP-сервер, Skill, автозапуск, защита путей):",
        "  opencode plugin add git+https://<ваш git>/council-mcp.git#<версия>",
        "Файлы в проекте для opencode не нужны.",
      ].join("\n"),
    );
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
    // Skill для DSH (и других хостов, читающих .agents/skills).
    await put(".agents/skills/council/SKILL.md", template("skills/council/SKILL.md"));
    r.notes.push(
      [
        "DeepSeek Harness: добавьте в ~/.dsh/cordis.patch.yml (для всех профилей) или",
        "~/.dsh/profiles/<профиль>/cordis.patch.yml (если файл есть — допишите, не затирая):",
        "- insert:",
        "    - id: mcp-council",
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        "        serverName: council",
        "        transport: stdio",
        "        command: node",
        `        args: ['${o.bundlePath}', 'mcp']`,
        "        env:",
        "          COUNCIL_BASE_URL: !!js process.env.COUNCIL_BASE_URL",
        "          COUNCIL_API_KEY: !!js process.env.COUNCIL_API_KEY",
        "          COUNCIL_MODELS: !!js process.env.COUNCIL_MODELS",
        "          COUNCIL_WAIT_S: '45'",
        "        toolCallTimeoutMs: 60000",
      ].join("\n"),
    );
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
