import { describe, expect, it } from "vitest";

import { main, type CliIO } from "../src/cli/main.js";
import { FakeDriver, vote, type FakeScript } from "./fakes.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const okScript = (): FakeScript => ({
  "model-a": { vote: [vote("gRPC", 0.9)] },
  "model-b": { vote: [vote("gRPC", 0.8)] },
  "model-c": { vote: [vote("REST", 0.5)] },
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  extra: Partial<CliIO> = {},
  script: FakeScript = okScript(),
) {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    configDeps: () => fakeDeps(env),
    makeDriver: () => new FakeDriver(script),
    debug: false,
    ...extra,
  };
  const code = await main(argv, io);
  return { code, out, err };
}

describe("CLI", () => {
  it("без env падает с понятной ошибкой, кодом 2 и без stacktrace", async () => {
    const { code, out, err } = await run(["info"], {});
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/^Ошибка конфигурации council-mcp:\n {2}- COUNCIL_BASE_URL: не задана/);
    expect(err).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
  });

  it("info печатает конфиг без секретов", async () => {
    const { code, out } = await run(["info"], baseEnv);
    expect(code).toBe(0);
    expect(out).not.toContain(baseEnv.COUNCIL_API_KEY);
    expect(JSON.parse(out)).toMatchObject({ models: [{ id: "model-a" }, {}, {}] });
  });

  it("неизвестная команда и неизвестный флаг — код 2", async () => {
    expect((await run(["nope"], baseEnv)).code).toBe(2);
    const flag = await run(["info", "--bogus"], baseEnv);
    expect(flag.code).toBe(2);
    expect(flag.err).toMatch(/^council: /);
  });

  it("run --mode vote печатает отчёт в stdout и прогресс в stderr", async () => {
    const { code, out, err } = await run(
      ["run", "--mode", "vote", "-q", "REST или gRPC?", "--option", "REST", "--option", "gRPC"],
      baseEnv,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^🏛 Council · vote/);
    expect(out).toMatch(/Решение: gRPC/);
    expect(err).toMatch(/раунд vote:/);
    expect(err).toMatch(/✓/);
  });

  it("run --json отдаёт структурированный результат", async () => {
    const { code, out } = await run(
      ["run", "-q", "REST или gRPC?", "--option", "REST", "--option", "gRPC", "--json"],
      baseEnv,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ mode: "vote", status: "majority", decision: "gRPC" });
  });

  it("run без вопроса и с неподдерживаемым режимом — код 2", async () => {
    expect((await run(["run"], baseEnv)).code).toBe(2);
    const debate = await run(["run", "--mode", "debate", "-q", "x"], baseEnv);
    expect(debate.code).toBe(2);
    expect(debate.err).toMatch(/появится в следующих фазах/);
    expect((await run(["run", "-q", "x", "--max-rounds", "abc"], baseEnv)).code).toBe(2);
  });

  it("run, где никто не ответил, — код 1", async () => {
    const { code, out } = await run(
      ["run", "-q", "x", "--option", "a", "--option", "b"],
      baseEnv,
      {},
      {},
    );
    expect(code).toBe(1);
    expect(out).toMatch(/Статус: failed/);
  });

  it("doctor: эндпоинт, модели и агент", async () => {
    const good = await run(["doctor"], baseEnv, {
      fetch: fakeFetch(200, {
        data: [{ id: "model-a", context_length: 128000 }, { id: "model-b" }, { id: "model-c" }],
      }),
    });
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/✓ модель model-a · контекст 128000 \(в конфиге 32000\)/);
    expect(good.out).toMatch(/✓ участники: fake/);

    const missing = await run(["doctor"], baseEnv, {
      fetch: fakeFetch(200, { data: [{ id: "model-a" }] }),
    });
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/✗ модель model-b: нет в списке \/models/);

    const denied = await run(["doctor"], baseEnv, { fetch: fakeFetch(401, {}) });
    expect(denied.out).toMatch(/✗ эндпоинт .*ключ не принят \(HTTP 401\)/);
    expect(denied.out).not.toContain(baseEnv.COUNCIL_API_KEY);
  });
});
