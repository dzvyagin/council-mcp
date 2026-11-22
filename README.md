# council-mcp

Совет моделей для архитектурных решений. Перед ключевым изменением агент сам созывает несколько
моделей: они читают проект, обсуждают варианты и возвращают решение, возражения и ADR в
`docs/adr/`. Работает в opencode как плагин, в DeepSeek Harness и других хостах — как MCP-сервер.

## Что нужно

- Node.js 22.12+ и git
- [opencode](https://opencode.ai) V2
- OpenAI-совместимый эндпоинт и минимум две модели

## Установка в opencode

1. Задайте переменные окружения (например, в `~/.bashrc`):

   ```bash
   export COUNCIL_BASE_URL=https://llm.example/v1
   export COUNCIL_API_KEY=...
   export COUNCIL_MODELS=model-a,model-b,model-c
   ```

2. Поставьте плагин (один раз на машину):

   ```bash
   opencode plugin add git+https://github.com/dzvyagin/council-mcp.git
   ```

   Из внутреннего зеркала — тот же адрес вашего git. Закрепить версию — суффикс тега, например
   `…council-mcp.git#v0.1.0`.

3. Перезапустите фоновый сервис opencode, чтобы он увидел переменные:

   ```bash
   opencode service restart
   ```

В проекты ничего копировать не нужно: плагин сам подключает совет в любом проекте. Репозиторий —
готовый пакет (собранный `dist/` в нём), поэтому npm-реестр для установки не нужен.

Обновление: opencode кэширует плагин из git и сам его не обновляет. Удалите плагин и кэш, затем
поставьте снова:

```bash
opencode plugin remove git+https://github.com/dzvyagin/council-mcp.git
rm -rf ~/.cache/opencode/npm/git-council-mcp-*
opencode plugin add git+https://github.com/dzvyagin/council-mcp.git
```

## Как пользоваться

Просто работайте. Если задача меняет схему БД, контракты, публичное API, технологию или
консистентность, агент сам вызовет совет. Пример запроса:
«Kafka или RabbitMQ для событий заказов?». Простые правки, багфиксы и вопросы по коду
проходят без совета.

Итог — решение, особое мнение и ADR со статусом `proposed`. Утверждаете его вы, и агент начнёт
реализацию после вашего подтверждения.

Вызвать совет вручную: `/council:council <вопрос>`, `/council:debate`, `/council:vote`,
`/council:review`, `/council:embrace` (полный цикл от исследования до кода).

Автозапуск настраивается переменной `COUNCIL_AUTO_ROUTER`: `invoke` (по умолчанию) — агент
зовёт совет сам, `suggest` — сначала спрашивает вас, `off` — только вручную.

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
Секреты маскируются в промптах, логах и ADR. Ключ берётся только из окружения и не пишется в
конфиги. Сетевые вызовы идут только на `COUNCIL_BASE_URL`, телеметрии нет.

## Без доступа к git

Перенесите копию пакета папкой: `npm run release -- --dir /opt/council` на машине с репозиторием,
затем на целевой — `opencode plugin add git+file:///opt/council`.

## Подробнее

- [docs/USAGE.md](docs/USAGE.md): режимы, конфигурация, CLI, бюджет, артефакты, разработка
- [docs/PLAN.md](docs/PLAN.md): план и решения
