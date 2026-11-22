# DeepSeek Harness (DSH)

1. Задайте `COUNCIL_BASE_URL`, `COUNCIL_API_KEY`, `COUNCIL_MODELS` в окружении, из которого
   запускаете `dsh`.
2. Добавьте в `~/.dsh/cordis.patch.yml` (для всех профилей) или в
   `~/.dsh/profiles/<профиль>/cordis.patch.yml` (например, `web`). Если файл уже есть, допишите
   блок в конец, не затирая содержимое:

   ```yaml
   - insert:
       - id: mcp-council
         name: "@deepseek-ai/dsh-mcp-client"
         config:
           serverName: council
           transport: stdio
           command: node
           args: ["/home/you/council-mcp/dist/cli/index.js", "mcp"]
           env:
             COUNCIL_BASE_URL: !!js process.env.COUNCIL_BASE_URL
             COUNCIL_API_KEY: !!js process.env.COUNCIL_API_KEY
             COUNCIL_MODELS: !!js process.env.COUNCIL_MODELS
             COUNCIL_WAIT_S: "45"
           toolCallTimeoutMs: 60000
   ```

   Тот же блок с вашим путём печатает `node ~/council-mcp/dist/cli/index.js setup --host dsh`.

3. Скопируйте Skill: `integrations/skills/council/` → `.agents/skills/council/` проекта (или
   `~/.agents/skills/`). DSH не поддерживает MCP prompts, поэтому слэш-команду заменяет Skill.

4. Перезапустите DSH. Инструменты появятся как `mcp__council__council_deliberate` и т. д.

Почему `env` задан явно: DSH убирает из окружения дочернего процесса переменные, похожие на
секреты, поэтому ключ передаётся через `!!js process.env…`. Таймаут 60 с безопасен: вызов совета
ждёт не дольше 45 с и возвращает прогресс, дальше агент вызывает `council_wait`.

Участники совета по умолчанию — `opencode acp` (нужен opencode V2 в `PATH`). Можно указать любой
ACP-агент: `participant.agent = "custom"` в `council.config.json`.
