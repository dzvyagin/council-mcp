# DeepSeek Harness (dsh)

Подключение совета как MCP-сервера в конфигурации DSH (YAML, одна запись `@deepseek-ai/dsh-mcp-client` на сервер):

```yaml
- id: mcp-council
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: council
    transport: stdio
    command: node
    args: ["/abs/path/council-mcp/dist/cli/index.js", "mcp"]
    env:
      COUNCIL_BASE_URL: !!js process.env.COUNCIL_BASE_URL
      COUNCIL_API_KEY: !!js process.env.COUNCIL_API_KEY
      COUNCIL_MODELS: !!js process.env.COUNCIL_MODELS
      COUNCIL_AGENT: opencode
      COUNCIL_WAIT_S: "45"
    # По умолчанию 60 с на вызов: council_deliberate ждёт не дольше COUNCIL_WAIT_S (45 с)
    # и возвращает прогресс, дальше агент вызывает council_wait.
    toolCallTimeoutMs: 60000
```

Инструменты видны как `mcp__council__council_deliberate` и т. д. MCP prompts DSH не поддерживает — слэш-команду заменяет Skill: скопируйте `integrations/skills/council/` в `.agents/skills/council/` проекта (или `~/.agents/skills/`).

Участники совета запускаются через ACP. Профиль DSH для участников появится в фазе 9; до этого участники — `opencode acp` (`COUNCIL_AGENT=opencode`, нужен opencode V2 в PATH) или любой ACP-агент через `participant.agent = "custom"` в `council.config.json`.
