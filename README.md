# council-mcp

MCP-сервер «совета моделей» для ключевых архитектурных решений: consensus, debate, vote и review. Участники — агенты (через ACP), итог — решение с особым мнением и ADR в `docs/adr/`.

Статус: фаза 0 (каркас и конфигурация). План — [docs/PLAN.md](docs/PLAN.md).

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

Необязательные: `COUNCIL_WORKSPACE`, `COUNCIL_CONFIG`, `COUNCIL_AGENT` (`auto` / `opencode` / `dsh` / `custom`), `COUNCIL_QUALITY_THRESHOLD`, `COUNCIL_GUARD` (`on` / `off`), `COUNCIL_AUTO_ROUTER` (`off` / `suggest` / `invoke`), `COUNCIL_LOG_LEVEL`, `COUNCIL_DEBUG=1` (stacktrace внутренних ошибок).

Параметры моделей, умолчания, пути и защищённые файлы — в `council.config.json` в корне проекта, см. [council.config.example.json](council.config.example.json). Секреты в файле запрещены.

```bash
council info    # проверить итоговую конфигурацию (ключ маскируется)
```
