---
description: Дебаты совета — два варианта, судья, проверка обменом сторон
---

Проведи дебаты совета (MCP-сервер council) по запросу:

$ARGUMENTS

1. Выдели ровно два конкурирующих варианта и передай их в `options` (например, «REST» и «gRPC»).
2. Найди ключевые файлы (контракты, схема, ADR) для `context.files`, требования — в `context.notes`.
3. Вызови `council_deliberate` с `mode: "debate"` и `swap_sides: true`. Свои критерии судьи — в `criteria`.
4. Пока `status` = `running` — показывай строку прогресса и вызывай `council_wait`.
5. Покажи `report` без пересказа.
