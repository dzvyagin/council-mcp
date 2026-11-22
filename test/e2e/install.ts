/**
 * Установка council в изолированный opencode так же, как у пользователя: релиз в git-папку
 * (`scripts/release.mjs --dir`) и `opencode plugin add git+file://…` в отдельном HOME.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function opencodeEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

/** Ставит плагин из свежего релиза; возвращает HOME и путь к глобальному конфигу opencode. */
export function installPlugin(opencode: string): { home: string; globalConfig: string } {
  const release = mkdtempSync(join(tmpdir(), "council-release-dir-"));
  execFileSync(process.execPath, [join(ROOT, "scripts/release.mjs"), "--dir", release], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const home = mkdtempSync(join(tmpdir(), "council-oc-home-"));
  execFileSync(opencode, ["plugin", "add", `git+file://${release}`], {
    env: opencodeEnv(home),
    stdio: "ignore",
  });
  return { home, globalConfig: join(home, "config/opencode/opencode.json") };
}

/** Дописывает в глобальный конфиг фейкового провайдера для модели хоста. */
export function addHostModel(globalConfig: string, baseURL: string): void {
  const config = JSON.parse(readFileSync(globalConfig, "utf8")) as Record<string, unknown>;
  writeFileSync(
    globalConfig,
    JSON.stringify(
      {
        ...config,
        model: "fake/host",
        update: "disable",
        share: "disabled",
        providers: {
          fake: {
            name: "Fake",
            env: ["FAKE_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL },
            models: {
              host: {
                modelID: "host",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 128000, output: 8000 },
              },
            },
          },
        },
        agents: { title: { disabled: true } },
      },
      null,
      2,
    ),
  );
}
