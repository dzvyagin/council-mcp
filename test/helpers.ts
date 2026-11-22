import type { ConfigDeps } from "../src/core/config.js";

export const WS = "/work/project";

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
