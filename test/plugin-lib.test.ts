import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runSetup } from "../src/cli/setup.js";
import { loadConfig } from "../src/core/config.js";
import { WorkflowMachine } from "../src/core/workflow/machine.js";
import {
  councilSummary,
  editedPaths,
  globToRegExp,
  guard,
  patchPaths,
  protectedMatch,
  routerHint,
} from "../src/plugin/lib.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const ws = () => realpathSync(mkdtempSync(join(tmpdir(), "council-plugin-")));

describe("глобы и пути", () => {
  it.each([
    ["**/migrations/**", "db/migrations/001.sql", true],
    ["**/migrations/**", "migrations/001.sql", true],
    ["**/*.sql", "schema.sql", true],
    ["**/*.sql", "a/b/c.sql", true],
    ["**/openapi*.{yml,yaml,json}", "api/openapi.v2.yaml", true],
    ["**/openapi*.{yml,yaml,json}", "api/openapi.md", false],
    ["docs/architecture/**", "docs/architecture/c4/x.md", true],
    ["docs/architecture/**", "docs/adr/0001.md", false],
  ])("%s ~ %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it("пути правок: edit, write, patch", () => {
    expect(editedPaths("edit", { path: "db/migrations/1.sql" })).toEqual(["db/migrations/1.sql"]);
    expect(editedPaths("write", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(editedPaths("read", { path: "a.ts" })).toEqual([]);
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: db/migrations/002.sql\n+create table t();\n*** End Patch";
    expect(patchPaths(patch)).toEqual(["src/a.ts", "db/migrations/002.sql"]);
    expect(editedPaths("patch", { patchText: patch })).toEqual([
      "src/a.ts",
      "db/migrations/002.sql",
    ]);
    expect(protectedMatch("./db/migrations/1.sql", ["**/migrations/**"])).toBe("**/migrations/**");
  });
});

describe("guard", () => {
  const edit = (path: string) => ({
    tool: "edit",
    input: { path, oldString: "a", newString: "b" },
  });

  it("правка миграции без решения совета блокируется с понятным сообщением", async () => {
    const dir = ws();
    const d = await guard({
      projectDir: dir,
      ...edit("db/migrations/001_init.sql"),
      councilInSession: false,
      env: {},
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(
      /^нужно решение совета: «db\/migrations\/001_init\.sql» — защищённый путь \(\*\*\/migrations\/\*\*\)\. Вызови @architect/,
    );
  });

  it("разрешено: обычный файл, совет в сессии, ADR упоминает файл, COUNCIL_GUARD=off", async () => {
    const dir = ws();
    expect(
      (await guard({ projectDir: dir, ...edit("src/app.ts"), councilInSession: false, env: {} }))
        .allowed,
    ).toBe(true);
    expect(
      (
        await guard({
          projectDir: dir,
          ...edit("db/migrations/001.sql"),
          councilInSession: true,
          env: {},
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await guard({
          projectDir: dir,
          ...edit("db/migrations/001.sql"),
          councilInSession: false,
          env: { COUNCIL_GUARD: "off" },
        })
      ).allowed,
    ).toBe(true);
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    writeFileSync(
      join(dir, "docs/adr/0003-partitions.md"),
      "# 0003\nМиграция `db/migrations/002_partitions.sql`\n",
    );
    expect(
      (
        await guard({
          projectDir: dir,
          ...edit("db/migrations/002_partitions.sql"),
          councilInSession: false,
          env: {},
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await guard({
          projectDir: dir,
          ...edit("db/migrations/003_other.sql"),
          councilInSession: false,
          env: {},
        })
      ).allowed,
    ).toBe(false);
  });

  it("защищённые пути — из council.config.json; абсолютные пути внутри проекта", async () => {
    const dir = ws();
    writeFileSync(
      join(dir, "council.config.json"),
      JSON.stringify({ protectedPaths: ["infra/**"] }),
    );
    expect(
      (
        await guard({
          projectDir: dir,
          ...edit(join(dir, "infra/main.tf")),
          councilInSession: false,
          env: {},
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await guard({
          projectDir: dir,
          ...edit("db/migrations/1.sql"),
          councilInSession: false,
          env: {},
        })
      ).allowed,
    ).toBe(true);
  });
});

describe("сводка для системного промпта", () => {
  it("активный процесс и последние решения; без состояния — ничего", async () => {
    const dir = ws();
    expect(await councilSummary(dir)).toBeUndefined();
    const config = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_WORKSPACE: dir }));
    const m = new WorkflowMachine({ config, newId: () => "wf-sum" });
    await m.start("Партиционирование платежей", "supervised");
    const s = await councilSummary(dir);
    expect(s).toMatch(
      /^<council-state>\nАктивный процесс совета wf-sum: Партиционирование платежей\nФаза discover, статус ready, autonomy supervised; гейты: discover ·, define ·, develop ·, deliver ·\./,
    );
    expect(s).toContain("</council-state>");
    expect(s!.length).toBeLessThan(1500);
  });

  it("подсказка роутера: suggest — предложить, invoke — запустить, off и команды — ничего", () => {
    expect(routerHint("REST или gRPC для внутреннего API?", "suggest")).toMatch(
      /похож на \/council-debate.*не запускай совет без его согласия/,
    );
    expect(routerHint("REST или gRPC для внутреннего API?", "invoke")).toMatch(
      /Запусти эту команду совета/,
    );
    expect(routerHint("REST или gRPC?", "off")).toBeUndefined();
    expect(routerHint("/council что-то", "suggest")).toBeUndefined();
    expect(routerHint("Поправь опечатку", "suggest")).toBeUndefined();
  });
});

describe("setup ставит плагин", () => {
  it(".opencode/plugins/council.ts с путём к dist/plugin/lib.js", async () => {
    const dir = ws();
    await runSetup({
      workspace: dir,
      hosts: ["opencode"],
      force: false,
      bundlePath: "/opt/council/dist/cli/index.js",
    });
    const plugin = readFileSync(join(dir, ".opencode/plugins/council.ts"), "utf8");
    expect(plugin).toContain('const LIB = "file:///opt/council/dist/plugin/lib.js";');
    expect(plugin).toContain('ctx.tool.hook("execute.before"');
  });
});
