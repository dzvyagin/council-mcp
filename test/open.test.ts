import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { deliberate } from "../src/core/deliberate.js";
import { collectOpen, rebuildOpen } from "../src/core/state/open.js";
import { councilSummary } from "../src/plugin/lib.js";
import { FakeDriver, vote } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const ws = () => realpathSync(mkdtempSync(join(tmpdir(), "council-open-")));

function adr(dir: string, file: string, status: string, risks: string[], questions: string[]) {
  mkdirSync(join(dir, "docs/adr"), { recursive: true });
  writeFileSync(
    join(dir, "docs/adr", file),
    [
      `# ${file}`,
      "",
      `- Статус: ${status} (council: converged)`,
      "",
      "## Решение",
      "",
      "Сделать так.",
      "",
      "### Последствия и риски",
      "",
      ...risks.map((r) => `- ${r}`),
      "",
      "## Открытые вопросы",
      "",
      ...(questions.length > 0 ? questions.map((q) => `- ${q}`) : ["—"]),
      "",
      "## Совет",
      "",
      "- A: model",
      "",
    ].join("\n"),
  );
}

describe("реестр открытых вопросов", () => {
  it("вопросы и риски critical/major из действующих ADR; rejected и superseded — нет", async () => {
    const dir = ws();
    adr(
      dir,
      "0001-a.md",
      "proposed",
      ["[major] Рост таблицы → партиции", "[minor] Мелочь"],
      ["Кто владелец схемы?"],
    );
    adr(dir, "0002-b.md", "accepted", ["[critical] Потеря событий"], []);
    adr(dir, "0003-c.md", "rejected", ["[critical] Не считается"], ["Тоже не считается"]);
    adr(dir, "0004-d.md", "superseded", [], ["И это"]);
    const r = await collectOpen(join(dir, "docs/adr"));
    expect(r.questions.map((q) => [q.number, q.text])).toEqual([["0001", "Кто владелец схемы?"]]);
    expect(r.risks.map((q) => [q.number, q.text])).toEqual([
      ["0001", "[major] Рост таблицы → партиции"],
      ["0002", "[critical] Потеря событий"],
    ]);
    await rebuildOpen(join(dir, "docs/adr"), join(dir, ".council"));
    const md = readFileSync(join(dir, ".council/OPEN.md"), "utf8");
    expect(md).toContain("- Кто владелец схемы? — [ADR 0001](../docs/adr/0001-a.md)");
    expect(md).toContain("- [critical] Потеря событий — [ADR 0002](../docs/adr/0002-b.md)");
    expect(md).not.toContain("Не считается");
    // Сводка для системного промпта хоста.
    expect(await councilSummary(dir)).toMatch(
      /Открыто по решениям совета: вопросов 1, рисков critical\/major 2 — \.council\/OPEN\.md\. Например: Кто владелец схемы\? \(ADR 0001\)/,
    );
  });

  it("deliberate пересобирает OPEN.md после записи ADR", async () => {
    const dir = ws();
    const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir }));
    const driver = new FakeDriver({
      "model-a": { vote: [vote("a", 0.9)] },
      "model-b": { vote: [vote("a", 0.8)] },
      "model-c": { vote: [vote("b", 0.5)] },
    });
    const r = await deliberate(
      { mode: "vote", question: "a или b?", options: ["a", "b"], writeAdr: true },
      { config, driver, runId: "open-1" },
    );
    expect(r.adr_path).toBeDefined();
    expect(existsSync(join(dir, ".council/OPEN.md"))).toBe(true);
  });
});
