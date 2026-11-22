/**
 * E2E Double Diamond с настоящими участниками `opencode acp` (фейковый провайдер) в git-репозитории:
 * discover → define (ADR, worktree, PLAN.md) → develop (ревью в worktree) → deliver.
 * Запуск: COUNCIL_E2E=1 npm run test:e2e
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type CouncilConfig } from "../../src/core/config.js";
import { deliberate } from "../../src/core/deliberate.js";
import { WorkflowMachine, type PhaseRunner } from "../../src/core/workflow/machine.js";
import { AcpDriver } from "../../src/drivers/acp/driver.js";
import { opencodeProfile, which } from "../../src/drivers/acp/profiles.js";
import { baseEnv, fakeDeps, gitRepo } from "../helpers.js";
import { fakeProvider } from "./fake-provider.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");

describe.runIf(enabled && opencode)("e2e: Double Diamond на настоящем opencode", () => {
  let ws: string;
  let config: CouncilConfig;
  const provider = fakeProvider();

  beforeAll(async () => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "council-e2e-wf-")));
    gitRepo(ws);
    writeFileSync(join(ws, "README.md"), "# payments\nВнутренние сервисы общаются по protobuf.\n");
    execFileSync("git", ["commit", "-qam", "readme"], { cwd: ws });
    await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
    const { port } = provider.server.address() as AddressInfo;
    config = loadConfig(
      fakeDeps({
        ...baseEnv,
        COUNCIL_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        COUNCIL_MODELS: "fake-a,fake-b",
        COUNCIL_WORKSPACE: ws,
      }),
    );
  });
  afterAll(() => {
    provider.server.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("сквозной прогон: гейты пройдены, план в worktree, ревью читает код worktree", async () => {
    let n = 0;
    const runner: PhaseRunner = async (input, workspace) => {
      const driver = new AcpDriver(
        { ...config, workspace },
        { profile: opencodeProfile(opencode!) },
      );
      try {
        return await deliberate(input, { config, driver, runId: `e2e-wf-${String(++n)}` });
      } finally {
        await driver.dispose();
      }
    };
    const m = new WorkflowMachine({ config, newId: () => "wf-e2e" });
    await m.start("Как партиционировать таблицу платежей?", "supervised", {
      notes: "PostgreSQL 16",
    });

    const discover = await m.advance("wf-e2e", {}, runner);
    expect(discover.gate.passed).toBe(true);
    const define = await m.advance("wf-e2e", {}, runner);
    expect(define.gate.passed).toBe(true);
    const wt = define.state.phases.define.worktree_path!;
    expect(readFileSync(join(ws, wt, "PLAN.md"), "utf8")).toContain("**Миграция партиций**");

    // «Хост-агент» реализует план в worktree.
    writeFileSync(
      join(ws, wt, "migration.sql"),
      "CREATE TABLE payments_2026_11 PARTITION OF payments;\n",
    );
    execFileSync("git", ["add", "-N", "."], { cwd: join(ws, wt) });
    const diff = execFileSync("git", ["diff"], { cwd: join(ws, wt) }).toString();

    const develop = await m.advance("wf-e2e", { diff }, runner);
    expect(develop.gate.passed).toBe(true);
    const deliver = await m.advance("wf-e2e", { diff }, runner);
    expect(deliver).toMatchObject({ next: "done", state: { status: "done" } });

    // Участники develop/deliver работали в worktree: README прочитан там же.
    const reviewTurns = provider.requests.filter((q) =>
      q.tools?.some((t) => t.function.name === "council_submit_review"),
    );
    expect(reviewTurns.length).toBeGreaterThan(0);
    expect(readFileSync(join(ws, ".council/STATE.md"), "utf8")).toContain(
      "Фаза: завершён · статус: done",
    );
    expect(existsSync(join(ws, ".council/decisions.json"))).toBe(true);
    expect(
      execFileSync("git", ["branch", "--list", "council/*"], { cwd: ws }).toString(),
    ).toContain("council/e2e-wf-2");
  }, 600_000);
});
