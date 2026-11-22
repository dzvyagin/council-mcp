import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import { parseVersion } from "../src/drivers/acp/check.js";
import { plural } from "../src/core/output/format.js";
import {
  baseEnv as childBaseEnv,
  EXPLORE_AGENT,
  gitignoreToPatterns,
  opencodeProfile,
  readOnlyRules,
  resolveProfile,
} from "../src/drivers/acp/profiles.js";
import { baseEnv, fakeDeps, WS } from "./helpers.js";

const CONFIG = `${WS}/council.config.json`;
const config = loadConfig(
  fakeDeps(baseEnv, {
    [CONFIG]: {
      models: [
        { id: "model-a", effort: "high", reasoningField: "reasoning_content", context: 128000 },
      ],
      participant: { env: { HTTPS_PROXY: "http://proxy.bank:3128" } },
    },
  }),
);

type Rule = { action: string; resource: string; effect: string };

/** Повторяет семантику opencode V2: побеждает последнее совпавшее правило, `*` матчит и `/`. */
function decide(rules: Rule[], action: string, resource: string): string {
  const match = (pattern: string, value: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    ).test(value);
  let effect = "ask";
  for (const r of rules)
    if (match(r.action, action) && match(r.resource, resource)) effect = r.effect;
  return effect;
}

describe("права участника opencode", () => {
  const rules = readOnlyRules("participant");
  it.each([
    ["read", "src/app.ts", "allow"],
    ["glob", "**/*.sql", "allow"],
    ["grep", "TODO", "allow"],
    ["read", ".env", "deny"],
    ["read", "services/api/.env.local", "deny"],
    ["read", "certs/server.key", "deny"],
    ["read", ".council/runs/x.jsonl", "deny"],
    ["edit", "src/app.ts", "deny"],
    ["shell", "rm -rf /", "deny"],
    ["webfetch", "https://example.com", "deny"],
    ["websearch", "x", "deny"],
    ["execute", "*", "deny"],
    ["skill", "anything", "deny"],
    ["external_directory", "/etc/*", "deny"],
    ["subagent", EXPLORE_AGENT, "allow"],
    ["subagent", "general", "deny"],
    ["council_submit_vote", "*", "allow"],
    ["other_mcp_tool", "*", "deny"],
  ])("%s %s → %s", (action, resource, effect) => {
    expect(decide(rules, action, resource)).toBe(effect);
  });

  it("субагент не запускает субагентов и не сдаёт ответы за участника", () => {
    const helper = readOnlyRules("helper");
    expect(decide(helper, "subagent", EXPLORE_AGENT)).toBe("deny");
    expect(decide(helper, "council_submit_vote", "*")).toBe("deny");
    expect(decide(helper, "read", "src/app.ts")).toBe("allow");
  });
});

describe("opencodeProfile", () => {
  it("изолирует окружение, задаёт модель и не кладёт ключ в конфиг", async () => {
    process.env.SOME_HOST_SECRET = "host-secret";
    const launch = await opencodeProfile("/usr/bin/opencode").launch(config.models[0]!, config);
    try {
      expect(launch.command).toBe("/usr/bin/opencode");
      expect(launch.args).toEqual(["acp"]);
      const env = launch.env;
      expect(env.SOME_HOST_SECRET).toBeUndefined();
      expect(env.HTTPS_PROXY).toBe("http://proxy.bank:3128");
      expect(env.COUNCIL_PROVIDER_API_KEY).toBe("sk-test-123456");
      expect(env.OPENCODE_DB).toBe(":memory:");
      for (const flag of [
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_FREE_MODELS",
      ]) {
        expect(env[flag]).toBe("1");
      }
      expect(env.HOME).toMatch(/council-oc-/);
      expect(env.XDG_CONFIG_HOME?.startsWith(env.HOME!)).toBe(true);

      const content = env.OPENCODE_CONFIG_CONTENT!;
      expect(content).not.toContain("sk-test-123456");
      const oc = JSON.parse(content) as {
        providers: Record<string, unknown>;
        agents: Record<string, { permissions?: unknown; mode?: string }>;
      };
      expect(oc).toMatchObject({
        model: "council/m",
        default_agent: "councillor",
        update: "disable",
        share: "disabled",
      });
      expect(oc.providers.council).toMatchObject({
        env: ["COUNCIL_PROVIDER_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://llm.bank.local/v1" },
        models: {
          m: {
            modelID: "model-a",
            limit: { context: 128000, output: 8000 },
            compatibility: { reasoningField: "reasoning_content" },
            settings: { reasoningEffort: "high" },
          },
        },
      });
      expect(oc.agents.councillor?.permissions).toEqual(readOnlyRules("participant"));
      expect(oc.agents[EXPLORE_AGENT]?.mode).toBe("subagent");
      expect(oc.agents.title).toEqual({ disabled: true });
    } finally {
      delete process.env.SOME_HOST_SECRET;
      await launch.cleanup();
    }
  });
});

describe("resolveProfile", () => {
  it("auto находит opencode в PATH, иначе даёт понятную ошибку", () => {
    expect(resolveProfile(config, () => "/opt/bin/opencode").label).toBe("opencode acp");
    expect(() => resolveProfile(config, () => undefined)).toThrow(/не найден ACP-агент/);
  });

  it("custom берёт команду из конфига, dsh — пока не поддержан", () => {
    const custom = {
      ...config,
      participant: {
        ...config.participant,
        agent: "custom" as const,
        command: ["my-agent", "--acp"],
      },
    };
    expect(resolveProfile(custom).label).toBe("my-agent --acp");
    const dsh = { ...config, participant: { ...config.participant, agent: "dsh" as const } };
    expect(() => resolveProfile(dsh)).toThrow(/фазе 9/);
  });

  it("в окружение агента попадают только сеть и локаль", () => {
    const env = childBaseEnv({
      PATH: "/bin",
      HTTPS_PROXY: "p",
      AWS_SECRET_ACCESS_KEY: "x",
      HOME: "/root",
    });
    expect(env).toEqual({ PATH: "/bin", HTTPS_PROXY: "p" });
  });
});

describe("plural", () => {
  it.each([
    [1, "вызов"],
    [3, "вызова"],
    [5, "вызовов"],
    [11, "вызовов"],
    [22, "вызова"],
  ])("%i %s", (n, form) => {
    expect(plural(n, ["вызов", "вызова", "вызовов"])).toBe(form);
  });
});

describe("gitignoreToPatterns", () => {
  const patterns = gitignoreToPatterns(
    [
      "# comment",
      "",
      "node_modules/",
      "*.log",
      "/secrets.json",
      "config/local/*.yml",
      "!keep.log",
      "**/tmp",
      "*",
    ].join("\n"),
  );
  const rules = [...readOnlyRules("participant", patterns)];

  it.each([
    ["node_modules/x/index.js", "deny"],
    ["pkg/node_modules/a.js", "deny"],
    ["app.log", "deny"],
    ["logs/deep/app.log", "deny"],
    ["keep.log", "deny"],
    ["secrets.json", "deny"],
    ["sub/secrets.json", "allow"],
    ["config/local/db.yml", "deny"],
    ["tmp/x", "deny"],
    ["a/tmp", "deny"],
    ["src/app.ts", "allow"],
  ])("read %s → %s", (path, effect) => {
    expect(decide(rules, "read", path)).toBe(effect);
  });

  it("строка «*» не запрещает весь проект", () => {
    expect(patterns).not.toContain("*");
  });
});

describe("parseVersion", () => {
  it.each([
    ["2.3.2", "2.3.2"],
    ["v2.3.2\n", "2.3.2"],
    ["opencode v2.3.2", "2.3.2"],
    ["opencode 1.19.6 (abc)", "1.19.6"],
    ["unknown", undefined],
  ])("%s", (input, expected) => {
    expect(parseVersion(input)).toBe(expected);
  });
});
