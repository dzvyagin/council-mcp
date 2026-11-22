---
description: Быстрое голосование совета по развилке
---

Проведи быстрое голосование совета (MCP-сервер council) по запросу:

$ARGUMENTS

Выдели 2–5 вариантов и передай их в `options`, вызови `council_deliberate` с `mode: "vote"`. Пока `status` = `running` — вызывай `council_wait`. Покажи `report` без пересказа. Если голоса разделились (`tie`), предложи запустить `/council`.
