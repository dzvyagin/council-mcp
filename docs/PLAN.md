# Council MCP — план v2 (черновик на согласование)

Дата: 2026-11-22. Основа — исходный план «Council MCP — план реализации для Claude Code» (21.11.2026), исправленный по итогам исследования. Расхождения с исходным планом помечены **[Δ]**.

## Принятые решения

| # | Решение | Статус |
|---|---|---|
| D1 | Участники совета — полноценные агенты через ACP (Agent Client Protocol): читают репозиторий, вызывают субагентов, режим только чтения | согласовано |
| D2 | Свой MCP-сервер на TypeScript; UX и процесс — по образцу Claude Octopus | согласовано |
| D3 | Объём — полный план (все команды, Double Diamond, хуки, usage) | согласовано |
| D4 | Хосты: opencode V2 (основной), DeepSeek Harness (`dsh`), позже веб-агент на deepagents | согласовано |
| D5 | Зависимости: runtime — `@modelcontextprotocol/sdk`, `@agentclientprotocol/sdk`, `zod`, `pino`, `ignore`; dev — `typescript`, `vitest`, `eslint`, `prettier`, `tsx`, `tsup`. Убраны `openai`, `p-limit`, `fast-glob`. opencode и DSH **не зависимости** — это потребители (хосты) | согласовано |
| D6 | Все вызовы моделей (включая синтез, судью, vote) — через ACP-участников, второго пути к модели нет | согласовано |
| D7 | Чем запускаются участники, если opencode/DSH не зависимости: ACP-команда из конфига (что установлено у пользователя) или встроенный агентный рантайм | **на согласовании** |

## Что изменилось относительно исходного плана

1. **[Δ] Участники — агенты, а не chat completions.** Пункт «Не делаем: агентный цикл с инструментами у участников; запуск CLI-агентов в роли участников» снят. Агентный цикл не пишем — берём готовый (`opencode acp`, `dsh acp`).
2. **[Δ] opencode — версия V2 (v2.3.0).** Конфиг: `mcp.servers.<name>`, `disabled` вместо `enabled`; права — упорядоченный список `permissions` (последнее совпадение побеждает); инструмент субагентов — `subagent`; команды — `.opencode/commands/`; плагины — `Plugin.define` из `@opencode/plugin`, V1-плагины не работают.
3. **[Δ] opencode не отображает MCP progress notifications** (обработчик пустой). Лимит выполнения MCP-вызова — 12 ч, так что обрыва нет, но и живого прогресса нет.
4. **[Δ] DSH: таймаут вызова MCP-инструмента 60 с, MCP prompts не поддерживаются.** Отсюда — асинхронный контракт инструментов (см. «Контракт»).
5. **[Δ] Пространства имён `/council:debate`** в opencode дают только MCP prompts; файлы команд в подпапке дают `/council/debate`.
6. **[Δ] Маскирование «до промпта» теперь недостаточно:** агенты читают файлы сами. Защита — правила `permissions` участника (deny на `.env*`, `.council/**`, секретные пути) + маскирование транскриптов до записи.
7. **[Δ] Пакет контекста упрощается:** хост передаёт вопрос, заметки, дифф и подсказки по файлам; полный сбор контекста делают сами участники.
8. **[Δ] Worktree-handoff остаётся** (D3), но код в нём пишет хост-агент; участники только читают.

## Архитектура

```
 opencode / DSH / deepagents (хост)
        │ MCP (stdio или Streamable HTTP)
        ▼
 council-mcp ── mcp/server.ts ── tools + prompts + instructions
        │
        ▼
 core (без MCP SDK): engine, protocols, panel, gates, workflow, output
        │ ParticipantDriver
        ▼
 AcpDriver ──spawn──► opencode acp (модель A, read-only) ─┐
           ──spawn──► opencode acp (модель B, read-only) ─┼─► OpenAI-совместимый эндпоинт банка
           ──spawn──► opencode acp (модель C, read-only) ─┘
        ▲
        └── loopback MCP (127.0.0.1, токен на участника): submit_answer(schema раунда)
```

### Участник = ACP-сессия

- Клиент: `@agentclientprotocol/sdk` (Apache-2.0, Zed, стабильный v1).
- Агент-участник **не входит в зависимости пакета** (D5); команда запуска берётся из конфига (см. D7). Пример ниже — для `opencode acp`, один процесс на участника, изолированное окружение:
  - `OPENCODE_CONFIG_CONTENT` — провайдер банка, модель участника, агент `councillor` с read-only `permissions`;
  - `OPENCODE_DB=:memory:`, отдельные `XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, `OPENCODE_CONFIG_DIR`;
  - `OPENCODE_DISABLE_PROJECT_CONFIG=1` (проектный конфиг не ослабит права), `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_FREE_MODELS=1`, `"update":"disable"`, `"share":"disabled"`;
  - `rg` должен быть в PATH (иначе opencode качает его с github.com).
- Права участника: deny `*` → allow `read`/`glob`/`grep` → deny чтения `.env*` и `.council/**` → allow `subagent` только на свой read-only субагент `council-explore` → allow `council_submit_answer`. `shell`, `edit`, `webfetch`, `websearch`, `execute` (Code Mode) запрещены.
- Второй рубеж: все `session/request_permission` автоматически отклоняются и логируются; клиент не объявляет `fs`/`terminal`.
- Модель на сессию — `session/set_config_option` (`model`, `effort`).
- **Структурированный ответ:** council-mcp поднимает loopback Streamable HTTP MCP-эндпоинт на каждого участника и передаёт его в `session/new.mcpServers`. Инструмент `submit_answer` имеет JSON Schema раунда; аргументы валидируются zod на сервере, ошибка валидации возвращается модели для повтора. Раунд завершён по первому валидному `submit_answer`, а не по `stopReason` (субагенты opencode работают в фоне и могут пережить ход). Нет ответа → одно напоминание → ошибка участника.
- Таймауты и отмена — на нашей стороне: дедлайн раунда → `session/cancel` → kill процесса.
- Расход: `PromptResponse.usage` (без учёта субагентов — фиксируем это в отчёте как нижнюю оценку).
- `DshAcpDriver` — тот же клиент, другая команда (`dsh --profile acp`) и конфиг; read-only через sandbox-режим DSH.
- Пул прогретых процессов — оптимизация фазы 9, не раньше.

### Общие механики (из исходного плана, сохраняются)

Анонимизация (метки A/B/C, перемешивание по seed из `run_id`, имена моделей только в транскрипте), бюджет (`max_calls`, `max_tokens`, `max_duration_s` → `partial`), деградация (одна модель упала → продолжаем с двумя; осталась одна → `failed`), события `onEvent`, ядро без MCP SDK (правило eslint).

## Что берём у Octopus (MIT — промпты можно копировать с сохранением копирайта)

**Берём:** порядок фаз совета с проверкой бюджета перед каждой; изолированные блоки недоверенных данных с nonce (инструкции — только в блоке задачи); строгий вердикт `APPROVE|REVISE|BLOCK` (нет вердикта = REVISE); заголовки синтеза с сохранением меньшинства; `summary.json` + раскладка по участникам; учёт «слепых» участников (цитируют то, что не читали); ACH-промпты для debate; чек-листы слепых зон для discover; правила цитирования (`file:line` или `[inference]`); JSONL-журнал расхода с состояниями; формат истории STATE.md; dry-run с прогнозом.

**Адаптируем:** «семейство моделей» = идентификатор модели; вопросы пользователю — через параметры инструментов/гейт-инструменты, не AskUserQuestion; полноценные тексты персон (у Octopus большинство персон — только имя); реальные токены из ACP вместо chars/4; асинхронный контракт вместо блокирующего вызова на 300 с.

**Не повторяем ошибки Octopus:** кворум считает «ответил», а не «одобрил» (иначе `--goal advice` блокируется); синтаксис вето явно описан в схеме (`veto: true` в `flaws[]`), случайное срабатывание по `"severity":"critical"` невозможно; у критики и доработки — свои промпты; без эвристических оценок «за code fence»; без bash-монолита и «PROHIBITED»-инструкций хосту.

**Не берём:** бенчмарк-скоринг, пулы supersede, статуслайн/HUD, 40 хуков, пакеты персон.

## Контракт MCP-инструментов [Δ]

Из-за 60 с в DSH любой долгий инструмент работает так: **запускает задачу и ждёт до `wait_s` секунд** (по умолчанию 45; хост с большим лимитом может передать больше). Не успел — возвращает `status: "running"` + снимок прогресса (готовый текст с маркерами 🟥🟨🟦). Хост вызывает `council_wait(run_id)` до завершения. Это же решает отсутствие progress в opencode: прогресс виден в каждом снимке.

| Инструмент | Назначение |
|---|---|
| `council_deliberate` | consensus / debate / vote / review; поля входа — как в исходном плане + `wait_s` |
| `council_wait` | продолжить ожидание `run_id` (≤ `wait_s`), вернуть снимок или итог |
| `council_cancel` | отменить запуск |
| `council_workflow` | Double Diamond: `start / status / advance / retry / abort` (+ `wait_s`) |
| `council_estimate` | прогноз вызовов и токенов |
| `council_get_run` | итог прошлого запуска |
| `council_usage`, `council_info`, `council_doctor`, `council_route` | сервисные |

Результат — как в исходном плане (`structuredContent` + текст отчёта ≤ ~2 КБ, ответ участников обёрнут в `<council-output trust="untrusted">`), плюс `status: "running"` для промежуточных снимков.

Транспорты: stdio и Streamable HTTP — оба с фазы 5 (HTTP нужен веб-агенту и даёт «один URL для всех хостов»). Сервер поддерживает рукопожатие MCP 2025-11-25 (opencode по умолчанию `protocol: legacy`).

## Интеграция с хостами

| Слой | opencode V2 | DSH | deepagents | Claude Code / Codex / Gemini (бонус) |
|---|---|---|---|---|
| MCP-сервер | `mcp.servers.council` | MCP-конфиг DSH | langchain-mcp-adapters (HTTP) | да |
| Слэш-команды | **MCP prompts** → `/council:debate` без копирования файлов | Skills | — | MCP prompts (Claude Code, Gemini), Skills (Codex) |
| Инструкции | `instructions` сервера + `AGENTS.fragment.md` | то же | то же | то же |
| Skill `council` (SKILL.md) | `.agents/skills` | `.agents/skills` | SkillsMiddleware | `.claude/skills` / `.agents/skills` |
| Агенты `architect`, `conductor` | `.opencode/agents/*.md` | субагенты DSH / Skill | — | — |
| Хуки (фаза 9) | плагин V2: `session.hook("prompt")`, `session.hook("compaction")`, `tool.hook("execute.before")`, событие `session.created` | плагин DSH (позже) | — | — |
| Защита путей | правила `permissions` `edit: deny` на защищённые пути + хук для «нет ADR → блок» | — | — | — |

`council setup` (CLI) пишет конфиги для выбранного хоста, ставит Skill и агентов, добавляет `.council/` в `.gitignore`. Пользователь делает одну команду.

## Банковский контур

- Сеть: только эндпоинт провайдера. Проверить захватом трафика в фазе 1 (opencode и DSH).
- opencode: отключить каталог моделей, автообновление, бесплатные модели, share; закрепить версию; плагины — только локальные или с точной версией; `rg` предустановлен.
- Наш сервер: без телеметрии; loopback MCP только на 127.0.0.1 со случайным токеном; секреты только из env; маскирование в логах и транскриптах.

## Фазы (обновлённые)

0. **Каркас.** tsconfig strict, eslint (+ запрет MCP SDK в `core`), prettier, vitest, `npm run check`; `config.ts` (env + `council.config.json`, zod); понятная ошибка без stacktrace.
1. **ACP-драйвер + vote.** `AcpDriver` для `opencode acp` с изоляцией и read-only, loopback `submit_answer`, таймауты/отмена, учёт токенов; асинхронный job-раннер; режим vote + CLI. Скрипт проверки эндпоинта и моделей (открытые вопросы 1–3). Захват исходящего трафика.
   - Готово: `council run --mode vote` на реальном эндпоинте; юнит-тесты драйвера на фейковом ACP-агенте; попытка записи/шелла участником отклонена.
2. **Consensus.** Раунды 1–3, анонимизация, сходимость, судья «одинаковы/разные», синтез, деградация.
3. **Артефакты.** ADR, транскрипт JSONL, отчёт, `summary.json`, маскирование.
4. **Панель и гейты.** Персоны 3/5/7, стили, goal, кворум, вето, consensus score, `estimate`, `dry_run`, `research_first`.
5. **MCP-сервер и интеграция.** stdio + HTTP, инструменты с `wait_s`, MCP prompts, Skill, `architect`, AGENTS-фрагмент; подключение к opencode V2 и DSH.
6. **Debate и review.** ACH-дебаты, `swap_sides`, review с go/no-go.
7. **Double Diamond.** Машина фаз, STATE.md / decisions.json / integrity.json, worktree, `conductor`.
8. **Сервисные команды.** doctor, usage, route, models, setup.
9. **Хуки и эксплуатация.** Плагин opencode V2, бюджеты → `partial`, пул прогретых участников, `DshAcpDriver`, eval.

## Риски

- opencode V2 меняется еженедельно; инъекция MCP через ACP — `experimental` API. → Закрепить версию, e2e-тест на совместимость.
- Ресурсы: 2 процесса × ~150–300 МБ на участника (не измерено); panel 7 = 7 процессов. → Ограничение параллелизма, позже пул.
- Время и стоимость: агенты сами исследуют код — выше, чем у chat completions. → Бюджеты по умолчанию, `dry_run`.
- DSH — developer preview (0.2.3-alpha). → Второй приоритет, отдельный драйвер.
- Субагенты opencode не учитываются в `usage`. → Отчёт помечает расход как нижнюю оценку.

## Открытые вопросы к владельцу

- [ ] Идентификаторы трёх моделей; председатель по умолчанию (или по рейтингу)?
- [ ] Контекстные окна и лимиты RPM/TPM (если известны; иначе меряем в фазе 1).
- [ ] Есть ли reasoning-модели (влияет на `effort`)?
- [ ] Корпоративный npm-реестр/прокси; есть ли ripgrep и ACP-агент (opencode / dsh) на машинах пользователей?
- [ ] Принятый шаблон ADR и папка (по умолчанию `docs/adr/`)?
- [ ] Разрешены ли git worktree и ветки `council/*`?
- [ ] Цены за токен у провайдера или считаем только токены?
- [ ] Язык ответов совета и ADR — русский?
