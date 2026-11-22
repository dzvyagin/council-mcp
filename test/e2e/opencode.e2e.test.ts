/**
 * E2E с настоящим `opencode acp` (V2). Запуск: COUNCIL_E2E=1 npm run test:e2e
 *
 * 1. «Фейковый провайдер»: локальный OpenAI-совместимый сервер со скриптом (fake-provider.ts).
 *    Проверяет, что opencode принимает конфиг участника, видит только read-only инструменты и
 *    инструменты ответа, не читает .env, умеет звать read-only субагента, и что vote и consensus
 *    доходят до council-mcp.
 * 2. «Реальный эндпоинт»: если заданы COUNCIL_BASE_URL/COUNCIL_API_KEY/COUNCIL_MODELS —
 *    голосование на настоящих моделях.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, nodeConfigDeps, type CouncilConfig } from "../../src/core/config.js";
import { deliberate, type DeliberateInput } from "../../src/core/deliberate.js";
import { AcpDriver } from "../../src/drivers/acp/driver.js";
import { opencodeProfile, which } from "../../src/drivers/acp/profiles.js";
import { baseEnv, fakeDeps } from "../helpers.js";
import { fakeProvider, toolResults } from "./fake-provider.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");

describe.runIf(enabled && opencode)("e2e: opencode acp + фейковый провайдер", () => {
  let workspace: string;
  let config: CouncilConfig;
  const provider = fakeProvider();

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "council-e2e-"));
    writeFileSync(
      join(workspace, "README.md"),
      "# demo\nВнутренние сервисы общаются по protobuf.\n",
    );
    writeFileSync(join(workspace, ".env"), "DB_PASSWORD=hunter2\n");
    writeFileSync(join(workspace, ".gitignore"), "local-secrets/\n");
    mkdirSync(join(workspace, "local-secrets"));
    writeFileSync(join(workspace, "local-secrets/token.txt"), "ignored-file-content\n");
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
    const { port } = provider.server.address() as AddressInfo;
    config = loadConfig(
      fakeDeps({
        ...baseEnv,
        COUNCIL_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        COUNCIL_MODELS: "fake-a,fake-b",
        COUNCIL_WORKSPACE: workspace,
      }),
    );
  });
  beforeEach(() => {
    provider.requests.length = 0;
  });
  afterAll(() => {
    provider.server.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  async function run(input: DeliberateInput) {
    const driver = new AcpDriver(config, { profile: opencodeProfile(opencode!) });
    try {
      return await deliberate(input, { config, driver, runId: `e2e-${input.mode}` });
    } finally {
      await driver.dispose();
    }
  }

  function checkSandbox() {
    const reqs = provider.requests;
    // Служебный агент title отключён: запросов без инструментов нет.
    expect(reqs.filter((q) => (q.tools ?? []).length === 0)).toHaveLength(0);
    const isParticipant = (q: (typeof reqs)[number]) =>
      q.tools?.some((t) => t.function.name.startsWith("council_submit_")) ?? false;
    const participant = reqs.filter(isParticipant);
    const helper = reqs.filter((q) => !isParticipant(q));
    const names = (list: typeof reqs) =>
      new Set(list.flatMap((q) => q.tools?.map((t) => t.function.name) ?? []));
    for (const forbidden of ["edit", "write", "patch", "shell", "bash", "webfetch", "websearch"]) {
      expect(names(reqs).has(forbidden)).toBe(false);
    }
    // Субагент вызывался, сам субагентов не запускает и ответы за участника не сдаёт.
    expect(helper.length).toBeGreaterThan(0);
    expect([...names(helper)].some((n) => n === "subagent" || n.startsWith("council_"))).toBe(
      false,
    );
    expect(names(participant).has("subagent")).toBe(true);
    // .env не прочитан, README прочитан.
    const results = toolResults(reqs).join("\n");
    expect(results).not.toContain("hunter2");
    expect(results).not.toContain("ignored-file-content"); // путь из .gitignore
    expect(results).toContain("protobuf");
    // У каждого участника своя модель, и обе модели участвовали.
    expect(new Set(participant.map((q) => q.model))).toEqual(new Set(["fake-a", "fake-b"]));
  }

  it("vote: ответ доходит до council-mcp, песочница соблюдена", async () => {
    const r = await run({ mode: "vote", question: "REST или gRPC?", options: ["REST", "gRPC"] });
    expect(r.status).toBe("converged");
    expect(r.decision).toBe("gRPC");
    expect(r.usage.prompt_tokens).toBeGreaterThan(0);
    checkSandbox();
  }, 180_000);

  it("consensus: предложения, критика, доработка и синтез через настоящий opencode", async () => {
    const r = await run({
      mode: "consensus",
      question: "Как партиционировать таблицу платежей?",
      notes: "PostgreSQL 16",
    });
    expect(r.status).toBe("converged");
    expect(r.decision).toBe("Партиционировать таблицу платежей по месяцам");
    // Панель 3 на двух моделях: одна модель играет две персоны в отдельных сессиях.
    expect(r.votes?.map((v) => v.choice)).toEqual(Array(3).fill("pg-partition-by-month"));
    expect(new Set(r.participants.map((p) => p.personas[0])).size).toBe(3);
    expect(r.participants.every((p) => p.state === "ok")).toBe(true);
    expect(r.adr_path).toMatch(/^docs\/adr\/\d{4}-/);
    expect(existsSync(join(workspace, r.adr_path!))).toBe(true);
    expect(existsSync(join(workspace, r.transcript_path))).toBe(true);
    checkSandbox();
  }, 300_000);
});

describe.runIf(enabled && opencode)("e2e: debate и review через настоящий opencode", () => {
  let workspace: string;
  let config: CouncilConfig;
  const provider = fakeProvider();

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "council-e2e-dr-"));
    writeFileSync(join(workspace, "README.md"), "# demo\nВнутренние сервисы общаются по protobuf.\n");
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
    const { port } = provider.server.address() as AddressInfo;
    config = loadConfig(
      fakeDeps({
        ...baseEnv,
        COUNCIL_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        COUNCIL_MODELS: "fake-a,fake-b",
        COUNCIL_WORKSPACE: workspace,
      }),
    );
  });
  afterAll(() => {
    provider.server.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const run = async (input: DeliberateInput) => {
    const driver = new AcpDriver(config, { profile: opencodeProfile(opencode!) });
    try {
      return await deliberate(input, { config, driver, runId: `e2e-${input.mode}` });
    } finally {
      await driver.dispose();
    }
  };

  it("debate со swap_sides: судья выбирает gRPC в обоих прогонах", async () => {
    const r = await run({ mode: "debate", question: "REST или gRPC?", options: ["REST", "gRPC"], swapSides: true, maxRounds: 1 });
    expect(r.status).toBe("converged");
    expect(r.decision).toBe("gRPC");
    expect(r.debate?.passes).toHaveLength(2);
  }, 300_000);

  it("review диффа с заложенной SQL-инъекцией — NO-GO", async () => {
    const diff = 'diff --git a/src/api.ts b/src/api.ts\n+app.get("/payments", (req) => db.query("SELECT * FROM payments WHERE id = " + req.query.id));';
    const r = await run({ mode: "review", question: "Ревью эндпоинта платежей", diff });
    expect(r.review?.verdict).toBe("no-go");
    expect(r.gate.passed).toBe(false);
    expect(r.report).toMatch(/\[critical\] src\/api\.ts:1 SQL-инъекция/);
  }, 300_000);
});

const real =
  enabled &&
  opencode !== undefined &&
  process.env.COUNCIL_BASE_URL !== undefined &&
  process.env.COUNCIL_API_KEY !== undefined;

describe.runIf(real)("e2e: реальный эндпоинт", () => {
  it("vote на настоящих моделях даёт валидный результат", async () => {
    const config = loadConfig(nodeConfigDeps());
    const driver = new AcpDriver(config);
    try {
      const r = await deliberate(
        {
          mode: "vote",
          question: "Для внутреннего API между сервисами этого репозитория лучше REST или gRPC?",
          options: ["REST", "gRPC"],
        },
        { config, driver, runId: `e2e-${String(Date.now())}` },
      );
      console.log(r.report);
      expect(["converged", "majority", "tie", "partial"]).toContain(r.status);
      expect(r.votes?.length).toBeGreaterThanOrEqual(1);
    } finally {
      await driver.dispose();
    }
  }, 900_000);
});
