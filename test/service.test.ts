import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runSetup } from "../src/cli/setup.js";
import { loadConfig } from "../src/core/config.js";
import { deliberate } from "../src/core/deliberate.js";
import { renderDoctor, runDoctor } from "../src/core/doctor.js";
import { collectUsage, renderUsage } from "../src/core/usage.js";
// @ts-expect-error — JS-скрипт без типов
import { output as generated } from "../scripts/gen-templates.mjs";
import { FakeDriver, vote } from "./fakes.js";
import { baseEnv, fakeDeps, gitRepo } from "./helpers.js";

const ws = () => realpathSync(mkdtempSync(join(tmpdir(), "council-svc-")));
const BUNDLE = "/opt/council-mcp/dist/cli/index.js";

describe("council setup", () => {
  it("чистый репозиторий: команды, агенты, Skill, конфиг, .gitignore, opencode.jsonc", async () => {
    const dir = ws();
    gitRepo(dir);
    const r = await runSetup({
      workspace: dir,
      hosts: ["opencode"],
      force: false,
      bundlePath: BUNDLE,
      models: ["model-a", "model-b"],
    });
    expect(r.created).toEqual(
      expect.arrayContaining([
        ".agents/skills/council/SKILL.md",
        ".opencode/commands/council.md",
        ".opencode/commands/council-embrace.md",
        ".opencode/commands/council-auto.md",
        ".opencode/agents/architect.md",
        ".opencode/agents/conductor.md",
        "opencode.jsonc",
        "council.config.json",
      ]),
    );
    expect(r.created).toContain(".gitignore");
    const oc = JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf8")) as {
      mcp: {
        servers: {
          council: { command: string[]; environment: Record<string, string>; codemode: boolean };
        };
      };
    };
    expect(oc.mcp.servers.council).toMatchObject({
      command: ["node", BUNDLE, "mcp"],
      codemode: false,
      environment: { COUNCIL_API_KEY: "{env:COUNCIL_API_KEY}" },
    });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\.council\/$/m);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    // Конфиг валиден и без секретов.
    const cfgText = readFileSync(join(dir, "council.config.json"), "utf8");
    expect(cfgText).not.toMatch(/key|token|password/i);
    const cfg = loadConfig(
      fakeDeps(
        { ...baseEnv, COUNCIL_MODELS: undefined, COUNCIL_WORKSPACE: dir },
        { [join(dir, "council.config.json")]: cfgText },
      ),
    );
    expect(cfg.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);

    // Повторный запуск ничего не трогает.
    const again = await runSetup({
      workspace: dir,
      hosts: ["opencode"],
      force: false,
      bundlePath: BUNDLE,
    });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.skipped).toEqual(
      expect.arrayContaining(["opencode.jsonc (council уже настроен)", "council.config.json"]),
    );
  });

  it("чужой opencode.json и AGENTS.md не редактируются — для opencode.json выводится блок", async () => {
    const dir = ws();
    writeFileSync(join(dir, "opencode.json"), '{ "model": "x/y" }\n');
    writeFileSync(join(dir, "AGENTS.md"), "# Правила\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    const r = await runSetup({
      workspace: dir,
      hosts: ["opencode", "claude", "dsh"],
      force: false,
      bundlePath: BUNDLE,
    });
    expect(readFileSync(join(dir, "opencode.json"), "utf8")).toBe('{ "model": "x/y" }\n');
    expect(r.notes.join("\n")).toMatch(/Добавьте в opencode\.json[\s\S]*"council"/);
    expect(r.notes.join("\n")).toMatch(
      /DeepSeek Harness[\s\S]*serverName: council[\s\S]*\/opt\/council-mcp\/dist\/cli\/index\.js/,
    );
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Правила\n");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.council/\n");
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { council: { args: [BUNDLE, "mcp"] } },
    });
    expect(r.created).toContain(".claude/skills/council/SKILL.md");
  });

  it("шаблоны в бандле совпадают с integrations/ (npm run gen)", () => {
    expect(
      readFileSync(new URL("../src/cli/templates.generated.ts", import.meta.url), "utf8"),
    ).toBe(generated);
  });
});

describe("usage", () => {
  it("расход по моделям, режимам, персонам и дням из транскриптов", async () => {
    const dir = ws();
    const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir }));
    const script = () => ({
      "model-a": { vote: [vote("a", 0.9)] },
      "model-b": { vote: [vote("a", 0.8)] },
      "model-c": { vote: [vote("b", 0.5)] },
    });
    for (const id of ["20261120-000001", "20261122-000002"]) {
      await deliberate(
        { mode: "vote", question: "q", options: ["a", "b"] },
        {
          config,
          driver: new FakeDriver(script()),
          runId: id,
          now: () => Date.parse(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T10:00:00Z`),
        },
      );
    }
    const u = await collectUsage(config.paths.stateDir);
    expect(u.runs).toBe(2);
    expect(u.total).toMatchObject({ calls: 6, input: 600, output: 120 });
    expect(u.byModel.map((r) => [r.key, r.calls, r.runs])).toEqual(
      expect.arrayContaining([
        ["model-a", 2, 2],
        ["model-b", 2, 2],
        ["model-c", 2, 2],
      ]),
    );
    expect(u.byMode).toEqual([expect.objectContaining({ key: "vote", calls: 6, runs: 2 })]);
    expect(u.byPersona.map((r) => r.key).sort()).toEqual(["architect", "dba", "sre"]);
    expect(u.byDay.map((r) => r.key)).toEqual(["2026-11-20", "2026-11-22"]);
    expect(renderUsage(u)).toMatch(/^🏛 Council · расход · 2 запуска · 720 токенов · 6 вызовов/);
    const recent = await collectUsage(config.paths.stateDir, {
      sinceDays: 1,
      now: Date.parse("2026-11-22T12:00:00Z"),
    });
    expect(recent.runs).toBe(1);
  });
});

describe("doctor", () => {
  it("проверки: эндпоинт, модели, агент, ripgrep, git, права, .council в git", async () => {
    const dir = ws();
    gitRepo(dir);
    writeFileSync(join(dir, ".gitignore"), ".council/\n");
    const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir }));
    const checks = await runDoctor(config, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b", context_length: 16000 }] }),
          ),
        ),
      checkAgent: () =>
        Promise.resolve([{ name: "участники", level: "ok", detail: "opencode acp · v2.3.2" }]),
      which: (c) => (c === "git" ? "/usr/bin/git" : undefined),
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c.level]));
    expect(by).toMatchObject({
      эндпоинт: "ok",
      "модель model-a": "ok",
      "модель model-b": "warn", // окно меньше, чем в конфиге
      "модель model-c": "fail",
      участники: "ok",
      ripgrep: "warn",
      git: "ok",
      "запись в docs/adr": "ok",
      "запись в .council": "ok",
      ".council в git": "ok",
    });
    expect(renderDoctor(checks)).toMatch(/^🏛 Council · doctor · ошибок: 1 · предупреждений: 2/);

    const noModels = await runDoctor(config, {
      fetch: () => Promise.resolve(new Response("not found", { status: 404 })),
      checkAgent: () => Promise.resolve([]),
      which: () => undefined,
    });
    expect(noModels.find((c) => c.name === "эндпоинт")?.level).toBe("warn");
    expect(noModels.find((c) => c.name === "git")?.level).toBe("warn");
  });
});
