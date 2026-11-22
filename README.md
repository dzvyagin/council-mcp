# council-mcp

MCP-сервер «совета моделей» для ключевых архитектурных решений: consensus, debate, vote и review. Участники — агенты (через ACP), итог — решение с особым мнением и ADR в `docs/adr/`.

Статус: фаза 4 — consensus и vote с панелью персон, гейтами и прогнозом; ADR и транскрипты. План — [docs/PLAN.md](docs/PLAN.md).

## Как это устроено

Каждый участник — отдельный процесс ACP-агента (по умолчанию `opencode acp`, opencode V2), который council-mcp запускает со своей моделью, изолированным конфигом и правами только на чтение: читать и искать по проекту, звать read-only субагента; без правок, шелла и веба, без доступа к `.env*` и `.council/`. Ответ раунда агент сдаёт вызовом типизированного инструмента на loopback MCP-сервере council-mcp (127.0.0.1, токен на участника).

Агента council-mcp не содержит: он использует установленный у пользователя (`council doctor` покажет, что найдено).

## Разработка

```bash
npm install
npm run check   # typecheck, lint, format, test
npm run build   # dist/cli/index.js — один самодостаточный файл
```

## Конфигурация

Обязательные переменные окружения:

| Переменная         | Назначение                                               |
| ------------------ | -------------------------------------------------------- |
| `COUNCIL_BASE_URL` | OpenAI-совместимый эндпоинт                              |
| `COUNCIL_API_KEY`  | ключ доступа (только из env)                             |
| `COUNCIL_MODELS`   | модели через запятую, минимум две (или `models` в файле) |

Необязательные: `COUNCIL_WORKSPACE`, `COUNCIL_CONFIG`, `COUNCIL_AGENT` (`auto` / `opencode` / `custom`; `dsh` — в фазе 9), `COUNCIL_QUALITY_THRESHOLD`, `COUNCIL_GUARD` (`on` / `off`), `COUNCIL_AUTO_ROUTER` (`off` / `suggest` / `invoke`), `COUNCIL_LOG_LEVEL`, `COUNCIL_DEBUG=1` (stacktrace внутренних ошибок).

Параметры моделей, умолчания, пути и защищённые файлы — в `council.config.json` в корне проекта, см. [council.config.example.json](council.config.example.json). Секреты в файле запрещены.

```bash
council doctor  # эндпоинт, модели, найденный агент
council info    # итоговая конфигурация (ключ маскируется)
council run --mode vote -q "REST или gRPC для внутреннего API?" --option REST --option gRPC
```

Прогресс печатается в stderr, итоговый отчёт — в stdout (`--json` — структурированный результат).

Флаги `council run`: `--panel 3|5|7` (персон больше, чем моделей, — модель играет несколько персон, каждая в своей сессии, и не критикует своих), `--style balanced|adversarial|red-team|executive|implementation` (состав персон и форма итога), `--goal advice|decision|plan|implement|review` (ADR — для decision/plan/implement; план работ — для plan/implement), `--research-first` (шаг исследования перед раундами), `--budget-calls N`, `--budget-tokens N` (прогноз выше лимита — отказ до запуска, `--confirm-budget` — запустить всё равно), `--dry-run` (состав и прогноз без вызовов моделей).

Гейты: кворум раунда ⌊panel/2⌋ + 1 ответов; вето SRE и безопасности на critical-недостаток решения большинства (не снято доработкой — `vetoed`, ADR со статусом `rejected`); consensus score = доля уверенности большинства − 0,1 за каждый незакрытый major против большинства; гейт — score ≥ `COUNCIL_QUALITY_THRESHOLD` (0,75) и нет вето.

## Артефакты

- `docs/adr/NNNN-<slug>.md` — ADR на основе MADR 4.0: контекст, варианты, решение и обоснование, риски, способ проверки, плюсы и минусы вариантов, особое мнение, открытые вопросы, состав совета (только метки участников). Номер = максимальный + 1, существующие файлы не перезаписываются, статус всегда `proposed`. Индекс `docs/adr/README.md` ведётся, только если создан советом.
- `.council/runs/<run_id>.jsonl` — транскрипт: каждая попытка каждого участника (модель, роль, хеш промпта, расход, текст агента, разобранный ответ или ошибка). Реальные имена моделей — только здесь. Папка `.council/` сама себя исключает из git (`.council/.gitignore`).
- Секреты (ключи, токены, пароли, строки подключения, PEM) маскируются во входе до промптов, в транскрипте, отчёте и ADR. Пути из корневого `.gitignore`, `.env*`, ключи и `.council/` участникам читать запрещено.

## E2E

```bash
COUNCIL_E2E=1 npm run test:e2e
```

Нужен opencode V2 в PATH. Тест с фейковым провайдером проверяет, что opencode принимает конфиг участника и не получает инструментов записи; с заданными `COUNCIL_BASE_URL`/`COUNCIL_API_KEY`/`COUNCIL_MODELS` дополнительно идёт голосование на реальных моделях.
