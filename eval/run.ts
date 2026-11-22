/**
 * Оценка качества: решение лучшей одиночной модели против решения совета на задачах eval/cases.
 * Нужен реальный эндпоинт (COUNCIL_BASE_URL, COUNCIL_API_KEY, COUNCIL_MODELS) и ACP-агент.
 *
 *   npx tsx eval/run.ts [--cases eval/cases] [--out eval/out] [--baseline <модель>] [--only 01,05]
 *
 * Результат: eval/out/<задача>/A.md, B.md (порядок случайный), checklist.md для человека,
 * key.json (что есть что и цена), eval/out/summary.json.
 */
import { parseArgs } from "node:util";

import { loadConfig, nodeConfigDeps } from "../src/core/config.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { listCases, runEval } from "../src/eval/runner.js";

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "eval/cases" },
    out: { type: "string", default: "eval/out" },
    baseline: { type: "string" },
    only: { type: "string" },
  },
});
const config = loadConfig(nodeConfigDeps());
const only = values.only?.split(",").map((s) => s.trim());
const cases = (await listCases(values.cases)).filter(
  (f) => !only || only.some((o) => f.includes(`/${o}`)),
);
const summary = await runEval({
  cases,
  outDir: values.out,
  config,
  makeDriver: (c) => new AcpDriver(c),
  ...(values.baseline !== undefined && { baselineModel: values.baseline }),
});
for (const c of summary.cases) {
  console.log(
    `${c.id}: одиночная ${String(c.single.calls)} выз. / ${String(c.single.tokens)} ток. / ${String(c.single.seconds)} с · совет ${String(c.council.calls)} выз. / ${String(c.council.tokens)} ток. / ${String(c.council.seconds)} с (${c.council.status})`,
  );
}
console.log(`Готово: ${values.out}. Оцените пары по checklist.md, не открывая key.json.`);
