# council-mcp

Совет моделей для архитектурных решений. Несколько моделей обсуждают вопрос, читают ваш проект и
возвращают решение, возражения и ADR в `docs/adr/`. Подключается к opencode, DeepSeek Harness и
любому MCP-хосту.

## Что нужно

- Node.js 22.12+
- [opencode](https://opencode.ai) V2 в `PATH`: им работают участники совета, только на чтение
- OpenAI-совместимый эндпоинт и минимум две модели

## Установка

```bash
git clone <репозиторий> ~/council-mcp
cd ~/council-mcp && npm install && npm run build
```

Получится `~/council-mcp/dist/`. Дальше нужна только эта папка, `npm install` в проектах не нужен.

## Подключение к opencode

1. Задайте переменные окружения (например, в `~/.bashrc`):

   ```bash
   export COUNCIL_BASE_URL=https://llm.example/v1
   export COUNCIL_API_KEY=...
   export COUNCIL_MODELS=model-a,model-b,model-c
   ```

2. Подготовьте проект:

   ```bash
   cd /path/to/project
   node ~/council-mcp/dist/cli/index.js setup --host opencode
   ```

3. Перезапустите opencode и проверьте подключение командой `/council-doctor`.

`setup` не трогает существующие файлы. Если в проекте уже есть `opencode.jsonc`, команда выведет
блок, который нужно вставить вручную.

## Как пользоваться

| Команда в opencode          | Когда                                                     |
| --------------------------- | --------------------------------------------------------- |
| `/council <вопрос>`         | открытый вопрос: совет предлагает, критикует, сводит итог |
| `/council-debate <A vs B>`  | выбор из двух вариантов                                   |
| `/council-vote <вопрос>`    | быстрое голосование                                       |
| `/council-review`           | ревью текущего диффа, итог «go» или «no-go»               |
| `/council-embrace <задача>` | полный цикл: исследование → решение → код → проверка      |

Пример: `/council Как хранить идемпотентные ключи платёжного API?`

Можно вызвать агента `@architect`, а можно просто спросить opencode о выборе: он сам предложит
нужную команду.

## Другие хосты

**DeepSeek Harness.** Выполните `node ~/council-mcp/dist/cli/index.js setup --host dsh`.
Команда выведет блок YAML. Добавьте его в `~/.dsh/cordis.patch.yml` и перезапустите DSH.
Подробности — в [integrations/dsh/README.md](integrations/dsh/README.md).

**Claude Code.** Выполните `setup --host claude`. Команда создаст `.mcp.json` и Skill.

**Любой MCP-хост.** Укажите команду сервера `node ~/council-mcp/dist/cli/index.js mcp` (stdio).
Для HTTP добавьте флаг `--http`, сервер будет слушать `127.0.0.1:8765`.

## Безопасность

Участники совета только читают проект. Им недоступны `.env*`, ключи и файлы из `.gitignore`.
Секреты маскируются в промптах, логах и ADR. Совет пишет только в `docs/adr/` и `.council/`.
Сетевые вызовы идут только на `COUNCIL_BASE_URL`, телеметрии нет.

## Подробнее

- [docs/USAGE.md](docs/USAGE.md): режимы, CLI, конфигурация, бюджет, артефакты, плагин opencode,
  разработка
- [docs/PLAN.md](docs/PLAN.md): план и решения
