import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { nodeConfigDeps, type CouncilConfig } from "../core/config.js";
import { AcpDriver } from "../drivers/acp/driver.js";
import { resolveProfile } from "../drivers/acp/profiles.js";
import { main } from "./main.js";
import { runMcp } from "./mcp.js";

const makeDriver = (config: CouncilConfig) =>
  new AcpDriver(config, {
    log: (m) => {
      if (process.env.COUNCIL_DEBUG === "1") process.stderr.write(`[acp] ${m}\n`);
    },
  });

if (process.argv[2] === "mcp") {
  try {
    await runMcp(process.argv.slice(3), makeDriver);
  } catch (e) {
    process.stderr.write(`council mcp: ${(e as Error).message}\n`);
    process.exit(2);
  }
} else {
  await runCli();
}

async function runCli(): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("\nОстанавливаю участников… (повторный Ctrl+C — выйти сразу)\n");
    controller.abort(new Error("прервано пользователем"));
  });

  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    configDeps: nodeConfigDeps,
    makeDriver,
    describeAgent: async (config) => {
      const profile = resolveProfile(config);
      if (profile.kind !== "opencode") return profile.label;
      try {
        const { stdout } = await promisify(execFile)("opencode", ["--version"], {
          timeout: 15_000,
        });
        return `opencode ${stdout.trim()}`;
      } catch {
        return "версию opencode определить не удалось";
      }
    },
    signal: controller.signal,
    debug: process.env.COUNCIL_DEBUG === "1",
  });
}
