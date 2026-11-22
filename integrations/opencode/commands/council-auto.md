---
description: Сам выбрать подходящую команду совета по запросу
---

Вызови `council_route` (MCP-сервер council) с запросом ниже. Если команда — `none`, скажи, что совет не нужен, и выполни запрос как обычно. Иначе назови выбранную команду и запусти её с предложенными параметрами (`council_deliberate`, `council_workflow`, `council_estimate`, `council_usage` — по смыслу команды), дальше — как в этой команде: пока `status` = `running` — `council_wait`, `report` — без пересказа.

$ARGUMENTS
