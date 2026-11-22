---
description: Фаза deliver отдельно — финальная red-team-проверка, go/no-go
---

Финальная проверка советом перед выкаткой (MCP-сервер council). Контекст:

$ARGUMENTS

Получи итоговый дифф (`git diff` или `git -C <worktree> diff`, новые файлы — через `git add -N .`), вызови `council_deliberate` с `mode: "review"` и `style: "red-team"`. Пока `status` = `running` — вызывай `council_wait`. Покажи `report` без пересказа. При NO-GO перечисли блокеры и не выкатывай.
