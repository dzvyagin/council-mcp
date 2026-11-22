import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigDeps } from "../src/core/config.js";

/** Временная рабочая папка процесса тестов: артефакты (ADR, транскрипты) не попадают в систему. */
export const WS = realpathSync(mkdtempSync(join(tmpdir(), "council-ws-")));

export const baseEnv = {
  COUNCIL_BASE_URL: "https://llm.bank.local/v1",
  COUNCIL_API_KEY: "sk-test-123456",
  COUNCIL_MODELS: "model-a,model-b,model-c",
  COUNCIL_WORKSPACE: WS,
};

/** Фейковые зависимости: env + виртуальная ФС из словаря путь → содержимое. */
export function fakeDeps(
  env: Record<string, string | undefined>,
  files: Record<string, unknown> = {},
): ConfigDeps {
  return {
    env,
    cwd: "/",
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) return undefined;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

/** git-репозиторий с одним коммитом (для worktree и handoff). */
export function gitRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}
