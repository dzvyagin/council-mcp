---
description: Фаза define отдельно — решение, ADR и план в git worktree
---

Вызови `council_deliberate` (MCP-сервер council) с `mode: "consensus"`, `goal: "implement"` и `handoff: "plan-only"` для задачи ниже (требования — в `context.notes`, ключевые файлы — в `context.files`). Пока `status` = `running` — вызывай `council_wait`. Покажи `report` без пересказа; если появился worktree — назови путь к `PLAN.md` и ветку. Реализацию не начинай без подтверждения.

$ARGUMENTS
