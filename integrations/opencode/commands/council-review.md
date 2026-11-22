---
description: Red-team-ревью текущих изменений советом, go/no-go
---

Проведи ревью изменений советом (MCP-сервер council). Что ревьюим:

$ARGUMENTS

1. Получи дифф текущих изменений: `git diff` и `git diff --staged` (если пусто — дифф последнего коммита `git show --stat -p HEAD`). Передай его в `context.diff`.
2. Ключевые затронутые файлы — в `context.files`.
3. Вызови `council_deliberate` с `mode: "review"` (по умолчанию стиль red-team).
4. Пока `status` = `running` — вызывай `council_wait`.
5. Покажи `report` без пересказа. При NO-GO перечисли блокеры и не выкатывай изменения.
