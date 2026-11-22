import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { buildContext } from "../src/core/context/builder.js";
import { findPriorDecisions, stems } from "../src/core/context/prior.js";
import { deliberate } from "../src/core/deliberate.js";
import { FakeDriver, vote } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const ws = () => realpathSync(mkdtempSync(join(tmpdir(), "council-prior-")));

function adr(dir: string, file: string, title: string, status: string, decision: string) {
  mkdirSync(join(dir, "docs/adr"), { recursive: true });
  writeFileSync(
    join(dir, "docs/adr", file),
    `# ${title}\n\n- Статус: ${status} (council: converged)\n\n## Решение\n\n${decision}\n`,
  );
}

describe("прежние решения по теме", () => {
  it("основы слов: регистр, короткие и служебные слова отбрасываются", () => {
    expect([...stems("Как партиционировать таблицу платежей?")].sort()).toEqual([
      "партиц",
      "платеж",
      "таблиц",
    ]);
  });

  it("находит похожие ADR, заголовок весит больше тела; чужие темы — нет", async () => {
    const dir = ws();
    adr(
      dir,
      "0001-партиционирование-платежей.md",
      "0001. Партиционирование таблицы платежей",
      "proposed",
      "По месяцам, pg_partman.",
    );
    adr(dir, "0002-брокер.md", "0002. Брокер событий заказов", "accepted", "Kafka.");
    adr(
      dir,
      "0003-архив.md",
      "0003. Архив старых данных",
      "proposed",
      "Партиции платежей старше года — в холодное хранилище.",
    );
    const prior = await findPriorDecisions(
      join(dir, "docs/adr"),
      dir,
      "Как партиционировать таблицу платежей по клиентам?",
    );
    expect(prior.map((p) => p.path)).toEqual([
      "docs/adr/0001-партиционирование-платежей.md",
      "docs/adr/0003-архив.md",
    ]);
    expect(prior[0]).toMatchObject({ status: "proposed" });
    expect(await findPriorDecisions(join(dir, "docs/adr"), dir, "Как назвать переменную?")).toEqual(
      [],
    );
    expect(await findPriorDecisions(join(dir, "нет"), dir, "партиционирование платежей")).toEqual(
      [],
    );
  });

  it("контекст: блок prior_decisions со списком и просьбой не противоречить молча", () => {
    const blocks = buildContext({
      prior: [{ path: "docs/adr/0001-x.md", title: "0001. X", status: "accepted" }],
    });
    expect(blocks[0]?.name).toBe("prior_decisions");
    expect(blocks[0]?.content).toMatch(
      /Не противоречь им молча[\s\S]*docs\/adr\/0001-x\.md — 0001\. X \(статус: accepted\)/,
    );
  });

  it("deliberate сам находит прежние ADR и передаёт их участникам; с входа поле не принимается", async () => {
    const dir = ws();
    adr(
      dir,
      "0001-партиционирование-платежей.md",
      "0001. Партиционирование таблицы платежей",
      "accepted",
      "По месяцам.",
    );
    const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir }));
    const driver = new FakeDriver({
      "model-a": { vote: [vote("a", 0.9)] },
      "model-b": { vote: [vote("a", 0.8)] },
      "model-c": { vote: [vote("b", 0.5)] },
    });
    await deliberate(
      {
        mode: "vote",
        question: "Партиционировать таблицу платежей по клиентам или по месяцам?",
        options: ["a", "b"],
        prior: [{ path: "docs/adr/9999-подлог.md", title: "подлог", status: "accepted" }],
      },
      { config, driver, runId: "prior-1" },
    );
    const prompt = driver.prompts[0]?.prompt ?? "";
    expect(prompt).toContain("docs/adr/0001-партиционирование-платежей.md");
    expect(prompt).not.toContain("подлог");
  });
});
