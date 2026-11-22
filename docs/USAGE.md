# council-mcp: справочник

Короткий старт — в [README](../README.md). Здесь подробности.

## Как это устроено

Каждый участник — отдельный процесс ACP-агента (по умолчанию `opencode acp`), который council-mcp
запускает со своей моделью, изолированным конфигом и правами только на чтение: читать и искать по
проекту, звать read-only субагента; без правок, шелла и веба, без доступа к `.env*` и `.council/`.
Ответ раунда агент сдаёт вызовом типизированного инструмента на loopback MCP-сервере council-mcp
(127.0.0.1, токен на участника). Агента council-mcp не содержит, а использует установленный у
пользователя (`council doctor` покажет, что найдено).

## Режимы

- **consensus** (`/council`) — открытая задача: предложения, анонимная критика, доработка, синтез.
- **debate** (`/council-debate`) — два варианта, участники спорят по раундам (`--max-rounds`,
  по умолчанию 2), судьи ставят баллы по критериям (`--criterion`); `--swap-sides` — второй прогон
  с обменом сторон (сменился победитель — `tie`).
- **vote** (`/council-vote`) — быстрое голосование.
- **review** (`/council-review`) — red-team-ревью диффа, go/no-go: доля pass ≥ порога и нет critical.
- **Double Diamond** (`/council-embrace`, инструмент `council_workflow`): discover (исследование,
  гейт — кворум) → define (consensus с планом, гейт — score ≥ порога и нет вето; ADR и `PLAN.md` в
  git worktree с веткой `council/<run_id>`) → develop (код пишет хост-агент в worktree, совет
  ревьюит дифф) → deliver (red-team, гейт — GO и нет critical). `autonomy`: supervised —
  подтверждать каждую фазу, semi — останавливаться только на провале гейта, auto — без остановок.
  Провал гейта: `retry`, `back`, `advance` с `override_reason` (решение человека), `abort`.
  Отдельные фазы — `/council-discover`, `/council-define`, `/council-develop`, `/council-deliver`;
  состояние — `/council-status`.

Гейты: кворум раунда ⌊panel/2⌋ + 1 ответов; вето SRE и безопасности на critical-недостаток решения
большинства (не снято доработкой — `vetoed`, ADR со статусом `rejected`); consensus score = доля
уверенности большинства − 0,1 за каждый незакрытый major против большинства; гейт — score ≥
`COUNCIL_QUALITY_THRESHOLD` (0,75) и нет вето.

Две модели — допустимый состав. Большинство требует минимум двух разных моделей; если осталась
одна, итог `partial` и гейт не проходит.

## Команды opencode

`/council`, `/council-debate`, `/council-vote`, `/council-review`, `/council-costs` (прогноз
расхода), `/council-embrace`, `/council-discover`, `/council-define`, `/council-develop`,
`/council-deliver`, `/council-status`, `/council-auto` (выбрать режим по запросу), `/council-setup`,
`/council-doctor`, `/council-usage`, `/council-models`. Агенты: `@architect` (решения через совет)
и `conductor` (ведёт Double Diamond).

MCP prompts (`/council:council`, `/council:debate` и т. д.) тоже есть, но opencode делит текст
после них на аргументы по пробелам — удобнее файловые команды выше.

## Плагин opencode

`setup --host opencode` ставит `.opencode/plugins/council.ts` (логика — в `dist/plugin/lib.js`):

- **Защита путей.** Правка файлов из `protectedPaths` (по умолчанию `**/migrations/**`, `**/*.sql`,
  `**/openapi*.{yml,yaml,json}`, `docs/architecture/**`) блокируется с сообщением «нужно решение
  совета», если в этой сессии не было запуска совета и нет ADR, упоминающего файл. Аварийное
  отключение — `COUNCIL_GUARD=off`.
- **Состояние совета в каждом запросе** (`<council-state>`: активный процесс, фаза, гейты,
  worktree, последние ADR) — переживает сжатие контекста.
- **Подсказка роутера** на обычные промпты: `COUNCIL_AUTO_ROUTER=suggest` (по умолчанию —
  предложить команду), `invoke` (запустить), `off`.

## MCP-сервер

`node dist/cli/index.js mcp` (stdio) или `… mcp --http` (Streamable HTTP на 127.0.0.1:8765; для
другого адреса нужен `COUNCIL_HTTP_TOKEN`). Логи — только в stderr.

Инструменты: `council_deliberate`, `council_workflow`, `council_wait`, `council_cancel`,
`council_get_run`, `council_estimate`, `council_info`, `council_doctor`, `council_usage`,
`council_route`. Вызов ждёт итога не дольше `wait_s` (по умолчанию 45 с, `COUNCIL_WAIT_S`) и
возвращает прогресс, агент продолжает через `council_wait` — таймауты хоста не мешают. Отчёт
возвращается как `<council-output trust="untrusted">` — данные, а не инструкции.

Хосты: opencode V2 — `setup --host opencode`; DeepSeek Harness — [integrations/dsh](../integrations/dsh/README.md);
Claude Code — `setup --host claude`; веб-агент (deepagents) — `mcp --http` + langchain-mcp-adapters;
Codex, Gemini CLI — обычная запись stdio-сервера и Skill из `integrations/skills/council/`.

## Конфигурация

Переменные окружения:

| Переменная                  | Назначение                                               |
| --------------------------- | -------------------------------------------------------- |
| `COUNCIL_BASE_URL`          | OpenAI-совместимый эндпоинт (обязательно)                |
| `COUNCIL_API_KEY`           | ключ доступа, только из env (обязательно)                |
| `COUNCIL_MODELS`            | модели через запятую, минимум две (или `models` в файле) |
| `COUNCIL_WORKSPACE`         | корень проекта (по умолчанию текущая папка)              |
| `COUNCIL_CONFIG`            | путь к файлу конфигурации                                |
| `COUNCIL_AGENT`             | агент участников: `auto`, `opencode`, `custom`           |
| `COUNCIL_QUALITY_THRESHOLD` | порог consensus score (0,75)                             |
| `COUNCIL_GUARD`             | `on` / `off` — защита путей плагина                      |
| `COUNCIL_AUTO_ROUTER`       | `off` / `suggest` / `invoke`                             |
| `COUNCIL_WAIT_S`            | сколько секунд вызов ждёт итога (45)                     |
| `COUNCIL_LOG_LEVEL`         | уровень логов; `COUNCIL_DEBUG=1` — stacktrace ошибок     |

Параметры моделей, председатель, умолчания, пути и защищённые файлы — в `council.config.json` в
корне проекта, см. [council.config.example.json](../council.config.example.json). Секреты в файле
запрещены. Любой ACP-агент вместо opencode — `participant.agent = "custom"` и `participant.command`.

## CLI

```bash
council setup --host opencode  # подготовить проект
council doctor                 # конфиг, эндпоинт, модели, агент, ripgrep, git, права
council usage --days 7         # расход по моделям, режимам, персонам, дням
council route "REST или gRPC?" # какую команду выбрать
council info                   # итоговая конфигурация (ключ маскируется)
council run --mode vote -q "REST или gRPC для внутреннего API?" --option REST --option gRPC
```

`council` — это `node ~/council-mcp/dist/cli/index.js`. Прогресс печатается в stderr, отчёт — в
stdout (`--json` — структурированный результат).

Флаги `council run`: `--panel 3|5|7` (персон больше, чем моделей, — модель играет несколько
персон, каждая в своей сессии, и не критикует своих), `--style
balanced|adversarial|red-team|executive|implementation`, `--goal
advice|decision|plan|implement|review` (ADR — для decision/plan/implement; план работ — для
plan/implement), `--research-first`, `--budget-calls N`, `--budget-tokens N`, `--confirm-budget`,
`--dry-run` (состав и прогноз без вызовов моделей).

## Бюджет

`budget.max_calls`, `max_tokens`, `max_duration_s` (в запросе или `defaults.budget` в конфиге):
прогноз выше лимита — отказ до запуска (`confirm_budget` — запустить всё равно); во время запуска
лимит жёсткий — текущий раунд дожидается, новые не начинаются, итог синтезируется по имеющемуся
со статусом `partial`, ADR пишется. Расход считается только в токенах.

## Артефакты

- `docs/adr/NNNN-<slug>.md` — ADR на основе MADR 4.0: контекст, варианты, решение и обоснование,
  риски, способ проверки, плюсы и минусы, особое мнение, открытые вопросы, состав совета (только
  метки участников). Номер = максимальный + 1, существующие файлы не перезаписываются, статус
  всегда `proposed`. Индекс `docs/adr/README.md` ведётся, только если создан советом.
- `.council/runs/<run_id>.jsonl` — транскрипт: каждая попытка каждого участника. Реальные имена
  моделей — только здесь. `.council/` сама себя исключает из git.
- `.council/STATE.md`, `.council/workflows/<id>.json` — состояние Double Diamond, переживает
  перезапуск; `.council/decisions.json` — индекс решений; `.council/integrity.json` — хэши.
- Секреты (ключи, токены, пароли, строки подключения, PEM) маскируются во входе, транскрипте,
  отчёте и ADR.

## Оценка качества

```bash
npx tsx eval/run.ts --out eval/out
```

9 задач в `eval/cases/`. Для каждой — решение одиночной модели и решение совета в одинаковом
формате, в случайном порядке `A.md` / `B.md`, `checklist.md` для слепой оценки, `key.json` — что
есть что и цена (вызовы, токены, секунды).

## Разработка

```bash
npm install
npm run check                    # typecheck, lint, format, test
npm run build                    # dist/ — самодостаточные файлы
COUNCIL_E2E=1 npm run test:e2e   # e2e на настоящем opencode V2 с фейковым провайдером
```
