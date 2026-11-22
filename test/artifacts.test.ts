import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../src/core/config.js";
import { deliberate, type DeliberateInput } from "../src/core/deliberate.js";
import {
  nextAdrNumber,
  renderAdr,
  slugify,
  writeAdr,
  type AdrData,
} from "../src/core/output/adr.js";
import { renderReport } from "../src/core/output/report.js";
import { critique, proposal, revision, synthesis } from "./consensus-builders.js";
import { FakeDriver, vote, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

function workspace(): { dir: string; config: CouncilConfig } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "council-art-")));
  return { dir, config: loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir })) };
}

const KEY = "pg-partition-by-month";
const ALL = ["A", "B", "C"];
const consensusScript = (): FakeScript => {
  // Очереди ответов — свои у каждой модели (FakeDriver их расходует).
  const seat = () => ({
    propose: [proposal(KEY)],
    "critique-1": [critique(ALL)],
    "revise-1": [revision(KEY)],
    synthesize: [synthesis(KEY)],
  });
  return { "model-a": seat(), "model-b": seat(), "model-c": seat() };
};

const SECRET_NOTES = "PostgreSQL 16. Доступ: DB_PASSWORD=hunter2, postgres://app:Sup3r@db/pay";

async function run(
  config: CouncilConfig,
  input: Partial<DeliberateInput> = {},
  runId = "20261122-aaaaaa",
) {
  return deliberate(
    {
      mode: "consensus",
      question: "Как партиционировать таблицу платежей?",
      notes: SECRET_NOTES,
      ...input,
    },
    {
      config,
      driver: new FakeDriver(consensusScript()),
      runId,
      now: () => Date.parse("2026-11-22T10:00:00Z"),
    },
  );
}

describe("артефакты запуска", () => {
  it("пишет ADR, транскрипт и .council/.gitignore; пути в результате относительные", async () => {
    const { dir, config } = workspace();
    const r = await run(config);

    expect(r.adr_path).toBe("docs/adr/0001-kak-partitsionirovat-tablitsu-platezhey.md");
    expect(r.transcript_path).toBe(".council/runs/20261122-aaaaaa.jsonl");
    expect(r.report).toContain(`ADR: ${r.adr_path}`);
    expect(readFileSync(join(dir, ".council/.gitignore"), "utf8")).toBe("*\n");

    const adr = readFileSync(join(dir, r.adr_path!), "utf8");
    expect(adr).toMatch(/^# 0001\. Как партиционировать таблицу платежей\?\n/);
    expect(adr).toContain(
      "- Статус: proposed (council: converged — единогласно, score 1.00, гейт 0.75 пройден)",
    );
    expect(adr).toContain(`Выбран вариант \`${KEY}\``);
    expect(adr).toContain("## Плюсы и минусы вариантов");
    expect(adr).toMatch(
      /\| A \| (Архитектор распределённых систем|Архитектор данных \/ DBA|SRE) \| `pg-partition-by-month` \| 0\.80 \| ok \|/,
    );
    expect(adr).not.toMatch(/model-[abc]/);

    const index = readFileSync(join(dir, "docs/adr/README.md"), "utf8");
    expect(index).toContain("<!-- council:adr-index -->");
    expect(index).toContain("[0001](0001-kak-partitsionirovat-tablitsu-platezhey.md)");
  });

  it("секреты из контекста не попадают ни в транскрипт, ни в ADR, ни в результат; модели — только в транскрипте", async () => {
    const { dir, config } = workspace();
    const r = await run(config);
    const transcript = readFileSync(join(dir, r.transcript_path), "utf8");
    const adr = readFileSync(join(dir, r.adr_path!), "utf8");
    for (const text of [transcript, adr, JSON.stringify(r)]) {
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("Sup3r");
      expect(text).not.toContain(baseEnv.COUNCIL_API_KEY);
    }
    expect(transcript).toContain("DB_PASSWORD=***");

    const lines = transcript
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      type: "run_started",
      run_id: "20261122-aaaaaa",
      ts: "2026-11-22T10:00:00.000Z",
    });
    expect(lines.at(-1)).toMatchObject({ type: "run_finished", status: "converged" });
    const asks = lines.filter((l) => l.type === "ask");
    expect(asks).toHaveLength(10); // 3 предложения + 3 критики + 3 доработки + синтез
    expect(asks[0]).toMatchObject({ round: "propose", attempt: 0 });
    expect(asks[0]!.model).toMatch(/^model-[abc]$/);
    expect(asks[0]!.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(asks[0]!.parsed).toMatchObject({ decision_key: KEY });
    expect(JSON.stringify(r)).not.toMatch(/model-[abc]/);
  });

  it("повторный запуск не трогает старый ADR, а добавляет следующий номер", async () => {
    const { dir, config } = workspace();
    const first = await run(config, {}, "20261122-000001");
    const before = readFileSync(join(dir, first.adr_path!), "utf8");
    const second = await run(config, {}, "20261122-000002");
    expect(second.adr_path).toBe("docs/adr/0002-kak-partitsionirovat-tablitsu-platezhey.md");
    expect(readFileSync(join(dir, first.adr_path!), "utf8")).toBe(before);
    expect(
      readFileSync(join(dir, "docs/adr/README.md"), "utf8").match(/^\| \[\d{4}\]/gm),
    ).toHaveLength(2);
  });

  it("продолжает нумерацию существующих ADR и не трогает чужой README", async () => {
    const { dir, config } = workspace();
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    writeFileSync(join(dir, "docs/adr/0007-old.md"), "# 0007. old\n");
    writeFileSync(join(dir, "docs/adr/README.md"), "# Наши ADR\n");
    const r = await run(config, { adrTitle: "Партиционирование платежей" });
    expect(r.adr_path).toBe("docs/adr/0008-partitsionirovanie-platezhey.md");
    expect(readFileSync(join(dir, "docs/adr/0007-old.md"), "utf8")).toBe("# 0007. old\n");
    expect(readFileSync(join(dir, "docs/adr/README.md"), "utf8")).toBe("# Наши ADR\n");
  });

  it("write_adr: false и failed — без ADR, но с транскриптом", async () => {
    const { dir, config } = workspace();
    const r = await run(config, { writeAdr: false });
    expect(r.adr_path).toBeUndefined();
    expect(readdirSync(join(dir, ".council/runs"))).toHaveLength(1);

    const failed = await deliberate(
      { mode: "vote", question: "q", options: ["a", "b"] },
      { config, driver: new FakeDriver({}), runId: "20261122-ffffff" },
    );
    expect(failed.status).toBe("failed");
    expect(failed.adr_path).toBeUndefined();
  });

  it("vote тоже пишет ADR с голосами", async () => {
    const { dir, config } = workspace();
    const r = await deliberate(
      { mode: "vote", question: "REST или gRPC?", options: ["REST", "gRPC"] },
      {
        config,
        driver: new FakeDriver({
          "model-a": { vote: [vote("gRPC", 0.9, "protobuf уже есть")] },
          "model-b": { vote: [vote("gRPC", 0.8, "строгие контракты")] },
          "model-c": { vote: [vote("REST", 0.5, "внешние клиенты")] },
        }),
        runId: "20261122-bbbbbb",
      },
    );
    const adr = readFileSync(join(dir, r.adr_path!), "utf8");
    expect(adr).not.toContain("Выбран вариант");
    expect(adr).toMatch(/- `gRPC` — gRPC \(за: [ABC], [ABC]\)/);
    expect(adr).toContain("## Особое мнение");
    expect(adr).toMatch(/REST — внешние клиенты/);
  });
});

describe("ADR: нумерация и slug", () => {
  it("slug с транслитерацией и ограничением длины", () => {
    expect(slugify("Выбор брокера: Kafka или RabbitMQ?")).toBe("vybor-brokera-kafka-ili-rabbitmq");
    expect(slugify("x".repeat(80))).toHaveLength(50);
    expect(slugify("???")).toBe("");
  });

  it("номер = максимальный + 1, пустая или отсутствующая папка — 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "council-adr-"));
    expect(await nextAdrNumber(join(dir, "missing"))).toBe(1);
    writeFileSync(join(dir, "0003-a.md"), "");
    writeFileSync(join(dir, "0010-b.md"), "");
    writeFileSync(join(dir, "notes.md"), "");
    expect(await nextAdrNumber(dir)).toBe(11);
  });

  it("при занятом номере (параллельный запуск) уступает и берёт следующий", async () => {
    const dir = mkdtempSync(join(tmpdir(), "council-adr-"));
    writeFileSync(join(dir, "0001-aaa.md"), "rival");
    const written = await writeAdr(dir, { ...ADR_FIXTURE, title: "zzz" });
    expect(written.number).toBe(2);
    expect(readFileSync(join(dir, "0001-aaa.md"), "utf8")).toBe("rival");
  });
});

const ADR_FIXTURE: AdrData = {
  title: "Партиционирование таблицы платежей",
  date: "2026-11-22",
  runId: "20261122-a1f3c9",
  mode: "consensus",
  transcript: ".council/runs/20261122-a1f3c9.jsonl",
  status: "majority",
  score: 0.81,
  gate: { threshold: 0.75, passed: true },
  question: "Как партиционировать таблицу платежей?",
  notes: "PostgreSQL 16, 2 млрд строк",
  decision: "Партиционировать по месяцам с автосозданием партиций",
  decisionKey: "partition-by-month",
  rationale: "A и B: запросы фильтруют по дате (src/repo.ts:42).",
  options: [
    {
      key: "partition-by-month",
      summary: "По месяцам",
      supporters: ["A", "B"],
      pros: ["простые запросы"],
      cons: ["[minor] горячая партиция"],
    },
    {
      key: "shard-by-tenant",
      summary: "Шардирование по тенанту",
      supporters: ["C"],
      pros: [],
      cons: ["[major] сложная миграция"],
    },
  ],
  rejected: [{ key: "archive-only", why: "не решает рост" }],
  risks: [{ risk: "Горячая партиция", severity: "major", mitigation: "мониторинг bloat" }],
  confirmation: "Нагрузочный тест: p95 запросов отчёта < 200 мс",
  dissent: "C: шардирование по тенанту лучше масштабируется",
  openQuestions: ["Срок хранения?", "Кто владелец миграции?"],
  participants: [
    {
      alias: "A",
      role: "архитектор распределённых систем",
      position: "partition-by-month",
      confidence: 0.85,
      state: "ok",
    },
    {
      alias: "B",
      role: "архитектор данных / DBA",
      position: "partition-by-month",
      confidence: 0.8,
      state: "ok",
    },
    {
      alias: "C",
      role: "SRE и безопасность",
      position: "shard-by-tenant",
      confidence: 0.6,
      state: "degraded",
      note: "1 ретрай: timeout",
    },
  ],
  warnings: [],
};

describe("снапшоты", () => {
  it("ADR", () => {
    expect(renderAdr(7, ADR_FIXTURE)).toMatchSnapshot();
  });

  it("отчёт", () => {
    expect(
      renderReport({
        run_id: "20261122-a1f3c9",
        mode: "consensus",
        status: "majority",
        decision: "Партиционировать по месяцам с автосозданием партиций",
        dissent: "C: шардирование по тенанту лучше масштабируется",
        score: 0.81,
        gate: { threshold: 0.75, passed: true },
        participants: [
          { alias: "A", personas: ["архитектор"], state: "ok" },
          { alias: "B", personas: ["DBA"], state: "ok" },
          { alias: "C", personas: ["SRE"], state: "degraded", note: "1 ретрай: timeout" },
        ],
        open_questions: ["Срок хранения?", "Кто владелец миграции?"],
        votes: [
          { alias: "A", choice: "partition-by-month", confidence: 0.85, rationale: "" },
          { alias: "B", choice: "partition-by-month", confidence: 0.8, rationale: "" },
          { alias: "C", choice: "shard-by-tenant", confidence: 0.6, rationale: "" },
        ],
        warnings: [],
        adr_path: "docs/adr/0007-partitsionirovanie-tablitsy-platezhey.md",
        transcript_path: ".council/runs/20261122-a1f3c9.jsonl",
        usage: { calls: 15, prompt_tokens: 170_000, completion_tokens: 12_400, duration_s: 220 },
      }),
    ).toMatchSnapshot();
  });
});
