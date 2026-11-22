/**
 * E2E установки прямо из репозитория, как `opencode plugin add git+https://…/council-mcp.git`:
 * npm внутри opencode берёт закоммиченный HEAD — без сборки, без npm-реестра (реестр и прокси
 * недоступны), плагин и CLI лежат в кэше opencode.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { which } from "../../src/drivers/acp/profiles.js";
import { opencodeEnv } from "./install.js";

const enabled = process.env.COUNCIL_E2E === "1";
const opencode = which("opencode");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function find(dir: string, suffix: string): string | undefined {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (p.endsWith(suffix)) return p;
    if (name.isDirectory()) {
      const hit = find(p, suffix);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe.runIf(enabled && opencode)("e2e: opencode plugin add прямо из git-репозитория", () => {
  it("ставится из HEAD без сборки и без npm-реестра", () => {
    const home = mkdtempSync(join(tmpdir(), "council-install-home-"));
    try {
      execFileSync(opencode!, ["plugin", "add", `git+file://${ROOT}`], {
        env: {
          ...opencodeEnv(home),
          npm_config_registry: "http://127.0.0.1:9/",
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
        },
        stdio: "pipe",
      });
      const plugin = find(join(home, "cache"), "council-mcp/dist/opencode/plugin.js");
      expect(plugin).toBeDefined();
      const pkg = join(plugin!, "../../..");
      expect(existsSync(join(pkg, "dist/cli/index.js"))).toBe(true);
      expect(existsSync(join(pkg, "dist/opencode/SKILL.md"))).toBe(true);
      expect(existsSync(join(pkg, "node_modules"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
