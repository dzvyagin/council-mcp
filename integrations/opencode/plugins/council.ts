// Плагин совета для opencode V2: защита путей, сводка процесса в системном промпте (переживает
// сжатие контекста), подсказка роутера. Вся логика — в council-mcp (dist/plugin/lib.js);
// путь подставляет `council setup`. Отключение защиты — COUNCIL_GUARD=off; роутер —
// COUNCIL_AUTO_ROUTER=off|suggest|invoke (по умолчанию suggest).
import { Plugin } from "@opencode/plugin";

const LIB = "__COUNCIL_PLUGIN_LIB__";

export default Plugin.define({
  id: "council",
  async setup(ctx) {
    const lib = await import(LIB);
    const projectDir = ctx.location.directory;
    const councilSessions = new Set<string>();
    const hints = new Map<string, string>();
    const routerMode = process.env.COUNCIL_AUTO_ROUTER ?? "suggest";

    // Защита путей: правка миграций, SQL, OpenAPI и т. п. — только после решения совета.
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool.startsWith("council_")) {
        councilSessions.add(event.sessionID);
        return;
      }
      const decision = await lib.guard({
        projectDir,
        tool: event.tool,
        input: event.input,
        councilInSession: councilSessions.has(event.sessionID),
      });
      if (!decision.allowed) throw new Error(decision.reason);
    });

    // Подсказка роутера на обычные промпты (без изменения текста пользователя).
    await ctx.session.hook("prompt", (event) => {
      const hint = lib.routerHint(event.prompt.text ?? "", routerMode);
      if (hint) hints.set(event.sessionID, hint);
      else hints.delete(event.sessionID);
    });

    // Каждый запрос агента: состояние совета (переживает сжатие контекста) и подсказка роутера.
    await ctx.session.hook("context", async (event) => {
      const summary = await lib.councilSummary(projectDir);
      if (summary) event.system.push({ type: "text", text: summary });
      const hint = hints.get(event.sessionID);
      if (hint) {
        event.system.push({ type: "text", text: hint });
        hints.delete(event.sessionID);
      }
    });

    // Сжатие контекста: итог сжатия тоже сохраняет решения совета.
    await ctx.session.hook("compaction", async (event) => {
      const summary = await lib.councilSummary(projectDir);
      if (summary) {
        event.system.push({
          type: "text",
          text: `Сохрани в итоге сжатия состояние совета:\n${summary}`,
        });
      }
    });
  },
});
