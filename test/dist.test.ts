/**
 * dist/ закоммичен: репозиторий сам является пакетом плагина (`opencode plugin add git+…`).
 * Тест пересобирает бандлы во временную папку и сверяет с dist/ — забытая пересборка
 * (`npm run bundle`) ломает `npm run check`, а не установку у пользователя.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("dist/ в репозитории", () => {
  it("совпадает со свежей сборкой (иначе: npm run bundle и закоммитить dist/)", () => {
    const out = mkdtempSync(join(tmpdir(), "council-dist-"));
    try {
      execFileSync(
        process.execPath,
        [join(ROOT, "node_modules/tsup/dist/cli-default.js"), "--out-dir", out, "--silent"],
        { cwd: ROOT, stdio: "ignore" },
      );
      const fresh = files(out)
        .map((p) => relative(out, p))
        .sort();
      expect(
        files(join(ROOT, "dist"))
          .map((p) => relative(join(ROOT, "dist"), p))
          .sort(),
      ).toEqual(fresh);
      for (const f of fresh) {
        expect(readFileSync(join(ROOT, "dist", f), "utf8"), f).toBe(
          readFileSync(join(out, f), "utf8"),
        );
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("package.json не заставляет npm собирать пакет из git и ничего не тянет из реестра", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies?: unknown;
      main: string;
    };
    // pacote «готовит» git-зависимость (вложенный npm install), если есть любой из этих скриптов;
    // встроенный npm opencode на этом падает.
    for (const s of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"])
      expect(pkg.scripts[s], s).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.main).toBe("./dist/opencode/plugin.js");
  });
});
