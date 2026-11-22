---
description: Подготовить проект к работе с советом и проверить окружение
---

Вызови MCP-промпт или выполни шаги сам:

1. Узнай путь к council: он указан в команде MCP-сервера `council` в `opencode.jsonc` (`node <путь>/dist/cli/index.js mcp`).
2. Выполни в корне проекта `node <путь>/dist/cli/index.js setup --host opencode` (добавь `--host claude` или `--host dsh` по запросу: $ARGUMENTS). Покажи вывод.
3. Вызови `council_doctor` (MCP-сервер council) и покажи результат. При ошибках подскажи, что исправить: переменные `COUNCIL_BASE_URL`, `COUNCIL_API_KEY`, `COUNCIL_MODELS` задаются в окружении, не в файлах.
