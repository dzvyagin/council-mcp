import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_PROTECTED_PATHS,
  describeConfig,
  loadConfig,
} from "../src/core/config.js";
import { baseEnv, fakeDeps, WS } from "./helpers.js";

const CONFIG = `${WS}/council.config.json`;

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error("ожидалась ConfigError");
}

describe("loadConfig: env", () => {
  it("собирает конфиг из env с умолчаниями", () => {
    const c = loadConfig(fakeDeps(baseEnv));
    expect(c.workspace).toBe(WS);
    expect(c.endpoint.baseUrl).toBe("https://llm.bank.local/v1");
    expect(c.endpoint.apiKey.reveal()).toBe("sk-test-123456");
    expect(c.models.map((m) => m.id)).toEqual(["model-a", "model-b", "model-c"]);
    expect(c.models[0]).toEqual({
      id: "model-a",
      context: 32_000,
      output: 8_000,
      maxConcurrency: 1,
    });
    expect(c.defaults).toEqual({
      panel: 3,
      style: "balanced",
      maxRounds: 2,
      majorityThreshold: 0.7,
      qualityThreshold: 0.75,
      budget: {},
    });
    expect(c.participant).toEqual({ agent: "auto", env: {}, roundTimeoutS: 900 });
    expect(c.paths).toEqual({ adrDir: `${WS}/docs/adr`, stateDir: `${WS}/.council` });
    expect(c.protectedPaths).toEqual(DEFAULT_PROTECTED_PATHS);
    expect(c.language).toBe("ru");
    expect(c.guard).toBe(true);
    expect(c.autoRouter).toBe("invoke");
    expect(c.configPath).toBeUndefined();
  });

  it("без env сообщает обо всех обязательных переменных сразу", () => {
    const issues = issuesOf(() => loadConfig(fakeDeps({})));
    expect(issues).toEqual([
      "COUNCIL_BASE_URL: не задана (адрес OpenAI-совместимого эндпоинта)",
      "COUNCIL_API_KEY: не задана (ключ доступа к эндпоинту)",
      "COUNCIL_MODELS: не задана (нужно минимум две модели через запятую, например model-a,model-b)",
    ]);
  });

  it("принимает две модели и отклоняет одну", () => {
    expect(loadConfig(fakeDeps({ ...baseEnv, COUNCIL_MODELS: "a, b" })).models).toHaveLength(2);
    expect(issuesOf(() => loadConfig(fakeDeps({ ...baseEnv, COUNCIL_MODELS: "a" })))).toEqual([
      "COUNCIL_MODELS: нужно минимум 2 модели, указано 1",
    ]);
  });

  it("отклоняет повторяющиеся модели", () => {
    const issues = issuesOf(() => loadConfig(fakeDeps({ ...baseEnv, COUNCIL_MODELS: "a,b,a" })));
    expect(issues).toEqual(["COUNCIL_MODELS: модели повторяются: a"]);
  });

  it("проверяет URL и числовые переменные", () => {
    const issues = issuesOf(() =>
      loadConfig(
        fakeDeps({ ...baseEnv, COUNCIL_BASE_URL: "ftp://x", COUNCIL_QUALITY_THRESHOLD: "1.5" }),
      ),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toBe("COUNCIL_BASE_URL: нужен URL вида https://host/v1");
    expect(issues[1]).toMatch(/^COUNCIL_QUALITY_THRESHOLD: /);
  });

  it("env перекрывает файл", () => {
    const c = loadConfig(
      fakeDeps(
        {
          ...baseEnv,
          COUNCIL_QUALITY_THRESHOLD: "0.9",
          COUNCIL_AGENT: "dsh",
          COUNCIL_GUARD: "off",
        },
        { [CONFIG]: { defaults: { qualityThreshold: 0.5 }, participant: { agent: "opencode" } } },
      ),
    );
    expect(c.defaults.qualityThreshold).toBe(0.9);
    expect(c.participant.agent).toBe("dsh");
    expect(c.guard).toBe(false);
  });
});

describe("loadConfig: council.config.json", () => {
  it("берёт параметры моделей из файла, а состав и порядок — из COUNCIL_MODELS", () => {
    const c = loadConfig(
      fakeDeps(
        { ...baseEnv, COUNCIL_MODELS: "model-b,model-a" },
        {
          [CONFIG]: {
            models: [
              {
                id: "model-a",
                effort: "high",
                reasoningField: "reasoning_content",
                context: 128000,
              },
              { id: "model-b", output: 4000 },
              { id: "unused" },
            ],
            chair: "model-a",
          },
        },
      ),
    );
    expect(c.configPath).toBe(CONFIG);
    expect(c.models).toEqual([
      { id: "model-b", context: 32_000, output: 4000, maxConcurrency: 1 },
      {
        id: "model-a",
        effort: "high",
        reasoningField: "reasoning_content",
        context: 128000,
        output: 8_000,
        maxConcurrency: 1,
      },
    ]);
    expect(c.chair).toBe("model-a");
  });

  it("без COUNCIL_MODELS использует модели из файла", () => {
    const env = { ...baseEnv, COUNCIL_MODELS: undefined };
    const c = loadConfig(fakeDeps(env, { [CONFIG]: { models: [{ id: "x" }, { id: "y" }] } }));
    expect(c.models.map((m) => m.id)).toEqual(["x", "y"]);
  });

  it("запрещает секреты в файле", () => {
    const issues = issuesOf(() =>
      loadConfig(
        fakeDeps(baseEnv, { [CONFIG]: { participant: { env: { OPENAI_API_KEY: "x" } } } }),
      ),
    );
    expect(issues).toEqual([
      `${CONFIG}: секреты в файле запрещены (participant.env.OPENAI_API_KEY). Передавайте их через переменные окружения.`,
    ]);
  });

  it("сообщает о неизвестных ключах, неверных значениях и битом JSON", () => {
    const issues = issuesOf(() =>
      loadConfig(fakeDeps(baseEnv, { [CONFIG]: { defaults: { panel: 4 }, typo: true } })),
    );
    expect(issues).toContain(`${CONFIG}: defaults.panel: ожидается 3, 5 или 7`);
    expect(issues.some((i) => i.includes("typo"))).toBe(true);

    const broken = issuesOf(() => loadConfig(fakeDeps(baseEnv, { [CONFIG]: "{ not json" })));
    expect(broken[0]).toMatch(/некорректный JSON/);
  });

  it("проверяет председателя и custom-агента", () => {
    const issues = issuesOf(() =>
      loadConfig(
        fakeDeps(baseEnv, { [CONFIG]: { chair: "model-z", participant: { agent: "custom" } } }),
      ),
    );
    expect(issues).toEqual([
      "chair: модель «model-z» не входит в состав совета (model-a, model-b, model-c)",
      'participant.command: обязателен при agent = "custom"',
    ]);
  });

  it("не выпускает пути за пределы workspace", () => {
    const issues = issuesOf(() =>
      loadConfig(
        fakeDeps(baseEnv, { [CONFIG]: { paths: { adrDir: "../adr", stateDir: "/tmp" } } }),
      ),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^paths\.adrDir: /);
    expect(issues[1]).toMatch(/^paths\.stateDir: /);
  });

  it("явный COUNCIL_CONFIG должен существовать, неявный — необязателен", () => {
    const issues = issuesOf(() =>
      loadConfig(fakeDeps({ ...baseEnv, COUNCIL_CONFIG: "missing.json" })),
    );
    expect(issues).toEqual([`COUNCIL_CONFIG: файл не найден: ${WS}/missing.json`]);
  });
});

describe("describeConfig", () => {
  it("не содержит секрета", () => {
    const text = JSON.stringify(describeConfig(loadConfig(fakeDeps(baseEnv))));
    expect(text).not.toContain("sk-test-123456");
    expect(text).toContain('"apiKey":"***"');
  });
});

describe("council.config.example.json", () => {
  it("проходит валидацию", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../council.config.example.json", import.meta.url), "utf8");
    const c = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_MODELS: undefined }, { [CONFIG]: text }));
    expect(c.models.map((m) => m.id)).toEqual(["model-a", "model-b", "model-c"]);
  });
});
