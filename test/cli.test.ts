import { describe, expect, it } from "vitest";

import { main, type CliIO } from "../src/cli/main.js";
import { baseEnv, fakeDeps } from "./helpers.js";

function run(argv: string[], env: Record<string, string | undefined>) {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    configDeps: () => fakeDeps(env),
    debug: false,
  };
  const code = main(argv, io);
  return { code, out, err };
}

describe("CLI", () => {
  it("без env падает с понятной ошибкой, кодом 2 и без stacktrace", () => {
    const { code, out, err } = run(["info"], {});
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/^Ошибка конфигурации council-mcp:\n {2}- COUNCIL_BASE_URL: не задана/);
    expect(err).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
  });

  it("info печатает конфиг без секретов", () => {
    const { code, out } = run(["info"], baseEnv);
    expect(code).toBe(0);
    expect(out).not.toContain(baseEnv.COUNCIL_API_KEY);
    expect(JSON.parse(out)).toMatchObject({ models: [{ id: "model-a" }, {}, {}] });
  });

  it("неизвестная команда и неизвестный флаг — код 2", () => {
    expect(run(["nope"], baseEnv).code).toBe(2);
    const flag = run(["info", "--bogus"], baseEnv);
    expect(flag.code).toBe(2);
    expect(flag.err).toMatch(/^council: /);
  });
});
