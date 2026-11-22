import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { autoRule, councilSummary, guard, routerHint } from "../plugin/lib.js";

/**
 * Плагин совета для opencode V2 — вся поставка для opencode (`opencode plugin add git+…`):
 * регистрирует MCP-сервер council для текущего проекта, Skill, правило автозапуска в
 * системном промпте, подсказку роутера, защиту путей и состояние совета в каждом запросе.
 * В проект при установке ничего не пишется.
 *
 * Секреты в конфиг opencode не попадают: MCP-сервер наследует окружение opencode
 * (COUNCIL_BASE_URL, COUNCIL_API_KEY, COUNCIL_MODELS), плагин задаёт только папку проекта.
 * Выключатели: COUNCIL_AUTO_ROUTER=off|suggest|invoke (по умолчанию invoke), COUNCIL_GUARD=off.
 *
 * Типы API плагина описаны здесь структурно: `@opencode/plugin` — потребитель, не зависимость.
 */

interface SystemPart {
  type: "text";
  text: string;
}
interface Hooks {
  hook(name: string, callback: (event: never) => unknown): Promise<unknown>;
}
interface Editor<T> {
  get(name: string): unknown;
  set(name: string, value: T): void;
}
interface SkillEditor {
  get(id: string): unknown;
  add(skill: SkillInfo): void;
}
interface SkillInfo {
  id: string;
  name: string;
  description: string;
  autoinvoke: boolean;
  path: string;
  content: string;
}
interface McpLocal {
  type: "local";
  command: string[];
  environment: Record<string, string>;
  codemode: boolean;
}
export interface PluginContext {
  location: { directory: string };
  tool: Hooks;
  session: Hooks;
  mcp: { transform(cb: (e: Editor<McpLocal>) => void): Promise<unknown> };
  skill: { transform(cb: (e: SkillEditor) => void): Promise<unknown> };
}

const here = dirname(fileURLToPath(import.meta.url));
/** dist/opencode/plugin.js → dist/cli/index.js и dist/opencode/SKILL.md. */
export const CLI_PATH = join(here, "..", "cli", "index.js");
export const SKILL_PATH = join(here, "SKILL.md");

/** Конфиг MCP-сервера council для проекта (без секретов). */
export function mcpServer(projectDir: string, cliPath = CLI_PATH): McpLocal {
  return {
    type: "local",
    command: ["node", cliPath, "mcp"],
    environment: { COUNCIL_WORKSPACE: projectDir },
    codemode: false,
  };
}

/** Skill из файла рядом с плагином: frontmatter (name, description) и тело. */
export function skillInfo(path = SKILL_PATH): SkillInfo | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "Совет моделей";
  return { id: "council", name: "council", description, autoinvoke: true, path, content: text };
}

export default {
  id: "council",
  async setup(ctx: PluginContext) {
    const projectDir = ctx.location.directory;
    const routerMode = process.env.COUNCIL_AUTO_ROUTER ?? "invoke";
    const councilSessions = new Set<string>();
    const hints = new Map<string, string>();

    // MCP-сервер совета для этого проекта (если council уже настроен в конфиге — не трогаем).
    await ctx.mcp.transform((e) => {
      if (!e.get("council")) e.set("council", mcpServer(projectDir));
    });
    const skill = skillInfo();
    if (skill) {
      await ctx.skill.transform((e) => {
        if (!e.get(skill.id)) e.add(skill);
      });
    }

    // Защита путей: правка миграций, SQL, OpenAPI и т. п. — только после решения совета.
    await ctx.tool.hook(
      "execute.before",
      async (event: { tool: string; sessionID: string; input: unknown }) => {
        if (event.tool.startsWith("council_")) {
          councilSessions.add(event.sessionID);
          return;
        }
        const decision = await guard({
          projectDir,
          tool: event.tool,
          input: event.input,
          councilInSession: councilSessions.has(event.sessionID),
        });
        if (!decision.allowed) throw new Error(decision.reason);
      },
    );

    // Подсказка роутера на обычные промпты (текст пользователя не меняется).
    await ctx.session.hook("prompt", (event: { sessionID: string; prompt: { text?: string } }) => {
      const hint = routerHint(event.prompt.text ?? "", routerMode);
      if (hint) hints.set(event.sessionID, hint);
      else hints.delete(event.sessionID);
    });

    // Каждый запрос агента: правило автозапуска, состояние совета (переживает сжатие
    // контекста) и подсказка роутера к первому запросу хода.
    await ctx.session.hook(
      "context",
      async (event: { sessionID: string; system: SystemPart[] }) => {
        const rule = autoRule(routerMode);
        if (rule) event.system.push({ type: "text", text: rule });
        const summary = await councilSummary(projectDir);
        if (summary) event.system.push({ type: "text", text: summary });
        const hint = hints.get(event.sessionID);
        if (hint) {
          event.system.push({ type: "text", text: hint });
          hints.delete(event.sessionID);
        }
      },
    );

    // Сжатие контекста: итог сжатия тоже сохраняет решения совета.
    await ctx.session.hook("compaction", async (event: { system: SystemPart[] }) => {
      const summary = await councilSummary(projectDir);
      if (summary)
        event.system.push({
          type: "text",
          text: `Сохрани в итоге сжатия состояние совета:\n${summary}`,
        });
    });
  },
};
