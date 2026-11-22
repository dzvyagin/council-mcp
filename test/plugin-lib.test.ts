import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
  autoRule,
} from "../src/plugin/lib.js";
import plugin, { CLI_PATH, councilOptions, mcpServer, skillInfo } from "../src/opencode/plugin.js";
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

  it("подсказка роутера: invoke — вызвать самому, suggest — предложить, off и команды — ничего", () => {
    const invoke = routerHint("REST или gRPC для внутреннего API?", "invoke");
    expect(invoke).toMatch(
      /Вызови сам, не спрашивая пользователя: council_deliberate с .*"mode":"debate"/,
    );
    expect(invoke).toContain("игнорируй подсказку");
    expect(routerHint("REST или gRPC для внутреннего API?", "suggest")).toMatch(
      /Предложи пользователю.*не запускай без его согласия/,
    );
    // Средняя уверенность — только «проверь, подходит ли».
    expect(routerHint("Нужна новая таблица для журнала платежей", "invoke")).toMatch(
      /Возможно, это ключевое решение/,
    );
    expect(routerHint("Сделай это от исследования до реализации", "invoke")).toMatch(
      /council_workflow с action "start"/,
    );
    expect(routerHint("REST или gRPC?", "off")).toBeUndefined();
    expect(routerHint("/council что-то", "invoke")).toBeUndefined();
  });

  it("правило автозапуска: invoke — сам, suggest — с согласием, off — нет", () => {
    expect(autoRule("invoke")).toMatch(/сам, не спрашивая разрешения, вызови совет/);
    expect(autoRule("invoke")).toContain("Простые правки, багфиксы");
    expect(autoRule("suggest")).toMatch(/после его согласия/);
    expect(autoRule("off")).toBeUndefined();
  });

  // Совет не должен запускаться на обычную работу с кодом (как negative eval у Octopus).
  it.each([
    "Поправь опечатку в README",
    "Исправь баг в сервисе оплаты: NPE при пустой корзине",
    "Что делает функция parseConfig?",
    "Сколько будет 7×8?",
    "Добавь лог в обработчик платежей",
    "Переименуй переменную userId в customerId в сервисе заказов",
    "Объясни, как работает кэш в этом модуле",
    "Запусти тесты",
    "Напиши юнит-тест для validateIban",
    "Почини падающий тест в платёжном API",
    "Покажи, где описан контракт заказов",
  ])("не запускаться: «%s»", (text) => {
    expect(routerHint(text, "invoke")).toBeUndefined();
  });

  it.each([
    "Kafka или RabbitMQ для событий заказов?",
    "Какую БД выбрать для платёжного журнала?",
    "Нужно разделить монолит на сервисы — как провести границы?",
    "Нужна новая таблица для журнала платежей и миграция данных",
    "Проверь изменения в ветке перед мержем: go/no-go",
  ])("запускаться: «%s»", (text) => {
    expect(routerHint(text, "invoke")).toBeDefined();
  });
});

describe("плагин opencode", () => {
  interface Registered {
    mcp: Map<string, unknown>;
    skills: Map<string, { id: string; autoinvoke: boolean; content: string }>;
    hooks: Map<string, (event: never) => unknown>;
  }
  async function load(dir: string): Promise<Registered> {
    const reg: Registered = { mcp: new Map(), skills: new Map(), hooks: new Map() };
    const hooks = {
      hook: (name: string, cb: (event: never) => unknown) => {
        reg.hooks.set(name, cb);
        return Promise.resolve();
      },
    };
    await plugin.setup({
      location: { directory: dir },
      tool: hooks,
      session: hooks,
      mcp: {
        transform: (cb) => {
          cb({ get: (n) => reg.mcp.get(n), set: (n, v) => reg.mcp.set(n, v) });
          return Promise.resolve();
        },
      },
      skill: {
        transform: (cb) => {
          cb({ get: (n) => reg.skills.get(n), add: (v) => reg.skills.set(v.id, v) });
          return Promise.resolve();
        },
      },
    });
    return reg;
  }

  it("MCP-сервер council: настройки из options важнее окружения сервиса", () => {
    const opts = councilOptions(
      {
        baseURL: "https://llm.bank/v1",
        apiKey: "sk-from-options",
        models: ["a", "b"],
        autoRouter: "suggest",
        node: "/usr/local/bin/node",
      },
      { COUNCIL_BASE_URL: "https://env/v1", COUNCIL_API_KEY: "sk-env", COUNCIL_AGENT: "opencode" },
    );
    expect(mcpServer("/work/p", opts, "/opt/c/dist/cli/index.js")).toEqual({
      type: "local",
      command: ["/usr/local/bin/node", "/opt/c/dist/cli/index.js", "mcp"],
      environment: {
        COUNCIL_BASE_URL: "https://llm.bank/v1",
        COUNCIL_API_KEY: "sk-from-options",
        COUNCIL_MODELS: "a,b",
        COUNCIL_AGENT: "opencode",
        COUNCIL_WORKSPACE: "/work/p",
      },
      codemode: false,
    });
    expect(opts.autoRouter).toBe("suggest");
  });

  it("без options — окружение; неподставленный {env:…} считается пустым", () => {
    const opts = councilOptions(
      { apiKey: "{env:COUNCIL_API_KEY}", models: "x, y" },
      { COUNCIL_API_KEY: "sk-env", COUNCIL_BASE_URL: "https://env/v1" },
    );
    expect(opts.environment).toEqual({
      COUNCIL_BASE_URL: "https://env/v1",
      COUNCIL_API_KEY: "sk-env",
      COUNCIL_MODELS: "x, y",
    });
    expect(opts.autoRouter).toBe("invoke");
    expect(opts.node).toBe("node");
  });

  it("регистрирует MCP, Skill и хуки; в системный промпт — правило автозапуска", async () => {
    const dir = ws();
    const reg = await load(dir);
    expect(reg.mcp.get("council")).toMatchObject({ environment: { COUNCIL_WORKSPACE: dir } });
    // Skill — из dist/opencode/SKILL.md; в исходниках его нет — проверяем разбор файла.
    const skill = skillInfo(
      fileURLToPath(new URL("../integrations/skills/council/SKILL.md", import.meta.url)),
    );
    expect(skill).toMatchObject({ id: "council", autoinvoke: true });
    expect(skill?.description).toMatch(/Вызывай сам/);
    expect([...reg.hooks.keys()].sort()).toEqual([
      "compaction",
      "context",
      "execute.before",
      "prompt",
    ]);

    const system: { type: string; text: string }[] = [];
    await (reg.hooks.get("prompt") as (e: unknown) => unknown)({
      sessionID: "s1",
      prompt: { text: "Kafka или RabbitMQ для событий заказов?" },
    });
    await (reg.hooks.get("context") as (e: unknown) => Promise<void>)({ sessionID: "s1", system });
    const text = system.map((p) => p.text).join("\n");
    expect(text).toContain("<council-rule>");
    expect(text).toContain("<council-hint>");
  });

  it("ручной блок council (устаревший путь) заменяется актуальным", async () => {
    const reg: Map<string, unknown> = new Map([["council", { type: "local", command: ["x"] }]]);
    const noop = { hook: () => Promise.resolve() };
    await plugin.setup({
      location: { directory: ws() },
      tool: noop,
      session: noop,
      mcp: {
        transform: (cb) => {
          cb({ get: (n) => reg.get(n), set: (n, v) => reg.set(n, v) });
          return Promise.resolve();
        },
      },
      skill: { transform: () => Promise.resolve() },
    });
    expect(reg.get("council")).toMatchObject({ type: "local", command: ["node", CLI_PATH, "mcp"] });
  });
});
