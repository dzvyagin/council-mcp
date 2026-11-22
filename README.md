# council-mcp

Совет моделей для архитектурных решений. Перед ключевым изменением агент сам созывает несколько
моделей: они читают проект, обсуждают варианты и возвращают решение, возражения и ADR в
`docs/adr/`. Работает в opencode как плагин, в DeepSeek Harness и других хостах — как MCP-сервер.

## Что нужно

- Node.js 22.12+ и git
- [opencode](https://opencode.ai) V2
- OpenAI-совместимый эндпоинт и минимум две модели

## Установка в opencode

Добавьте плагин в глобальный конфиг opencode `~/.config/opencode/opencode.json` (если файл уже
есть — допишите запись в массив `plugins`):

```json
{
  "plugins": [
    {
      "package": "git+https://github.com/dzvyagin/council-mcp.git",
      "options": {
        "baseURL": "https://llm.example/v1",
        "models": ["model-a", "model-b", "model-c"],
        "apiKey": "{file:~/.config/council/api-key}"
      }
    }
  ]
}
```

Положите ключ в файл (только для себя):

```bash
mkdir -p ~/.config/council && printf '%s' 'ВАШ_КЛЮЧ' > ~/.config/council/api-key && chmod 600 ~/.config/council/api-key
```

Перезапустите opencode:

```bash
opencode service restart
```

opencode сам скачает плагин из git, а плагин подключит совет в любом проекте. В проекты ничего
копировать не нужно, npm-реестр не нужен. Из внутреннего зеркала укажите адрес вашего git;
закрепить версию — суффикс тега (`…council-mcp.git#v0.1.0`).

Проверка: в opencode выполните `/council:setup` — агент вызовет `council_doctor` и покажет, что
не так. `opencode mcp list` сервер совета не показывает: он видит только серверы из файлов
конфига, а этот регистрирует плагин.

Ключ можно брать и из окружения — `"apiKey": "{env:COUNCIL_API_KEY}"`, но фоновый сервис
opencode запускает не ваша оболочка, и переменных из `~/.bashrc` или `~/.zshrc` он часто не
видит. Поэтому надёжнее файл.

Обновление: opencode кэширует плагин и сам его не обновляет. Удалите кэш и перезапустите
сервис:

```bash
find ~/.cache "${XDG_CACHE_HOME:-$HOME/.cache}" -maxdepth 3 -type d -name 'git-council-mcp-*' -prune -exec rm -rf {} + 2>/dev/null
opencode service restart
```

Если opencode запускается с другим `XDG_CACHE_HOME`, путь к плагину есть в логе:
`grep -ho 'entrypoint=file://[^ ]*council-mcp' ~/.local/share/opencode/log/opencode.log | tail -1`.

## Как пользоваться

Просто работайте. Если задача меняет схему БД, контракты, публичное API, технологию или
консистентность, агент сам вызовет совет. Пример запроса:
«Kafka или RabbitMQ для событий заказов?». Простые правки, багфиксы и вопросы по коду
проходят без совета.

Итог — решение, особое мнение и ADR со статусом `proposed`. Утверждаете его вы, и агент начнёт
реализацию после вашего подтверждения.

Вызвать совет вручную: `/council:council <вопрос>`, `/council:debate`, `/council:vote`,
`/council:review`, `/council:embrace` (полный цикл от исследования до кода).

Автозапуск — параметр `"autoRouter"` в `options`: `invoke` (по умолчанию) — агент зовёт совет
сам, `suggest` — сначала спрашивает вас, `off` — только вручную.

## Что появляется в проекте

- `docs/adr/` — решения совета.
- `.council/` — транскрипты, состояние процесса и `OPEN.md` с открытыми вопросами и рисками
  по всем ADR. Папка сама исключает себя из git.

Совет учитывает прежние ADR по теме: не противоречит им молча, а ссылается или явно предлагает
пересмотр.

## Другие хосты

**DeepSeek Harness** — инструкция в [integrations/dsh/README.md](integrations/dsh/README.md).

**Claude Code** — в папке проекта выполните `node <council>/dist/cli/index.js setup --host claude`.

**Любой MCP-хост** — команда сервера `node <council>/dist/cli/index.js mcp` (stdio), флаг `--http`
включает HTTP на `127.0.0.1:8765`.

`<council>` — папка с клоном репозитория: собранный `dist/` уже в нём.

## Безопасность

Участники совета только читают проект. Им недоступны `.env*`, ключи и файлы из `.gitignore`.
Секреты маскируются в промптах, логах и ADR. Ключ не пишется ни в проект, ни в
`opencode.json` — только ссылка на файл или переменную. Сетевые вызовы идут только на `COUNCIL_BASE_URL`, телеметрии нет.

## Без доступа к git

Перенесите копию пакета папкой: `npm run release -- --dir /opt/council` на машине с репозиторием,
затем на целевой укажите в конфиге `"package": "git+file:///opt/council"`.

## Подробнее

- [docs/USAGE.md](docs/USAGE.md): режимы, конфигурация, CLI, бюджет, артефакты, разработка
- [docs/PLAN.md](docs/PLAN.md): план и решения
