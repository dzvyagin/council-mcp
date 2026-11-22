---
description: Фаза develop отдельно — ревью реализации плана по диффу
---

Ревью реализации советом (MCP-сервер council). Контекст:

$ARGUMENTS

Получи дифф изменений (`git diff`, для новых файлов сначала `git add -N .`; если работа в worktree — `git -C <worktree> diff`) и вызови `council_deliberate` с `mode: "review"`, `style: "implementation"`, диффом в `context.diff` и `PLAN.md` в `context.files`, если он есть. Пока `status` = `running` — вызывай `council_wait`. Покажи `report` без пересказа.
