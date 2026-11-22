import { fileURLToPath } from "node:url";

import { nodeConfigDeps, type CouncilConfig } from "../core/config.js";
import { AcpDriver } from "../drivers/acp/driver.js";
import { checkAgent } from "../drivers/acp/check.js";
import { which } from "../drivers/acp/profiles.js";
import { main } from "./main.js";
import { runMcp } from "./mcp.js";
import { runWorker } from "./worker.js";

const makeDriver = (config: CouncilConfig) =>
  new AcpDriver(config, {
    log: (m) => {
      if (process.env.COUNCIL_DEBUG === "1") process.stderr.write(`[acp] ${m}\n`);
    },
  });

if (process.argv[2] === "worker") {
  process.exitCode = await runWorker(process.argv.slice(3), {
    configDeps: nodeConfigDeps,
    makeDriver,
  });
  process.exit();
} else if (process.argv[2] === "mcp") {
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
    checkAgent,
    which: (command) => which(command),
    bundlePath: fileURLToPath(import.meta.url),
    signal: controller.signal,
    debug: process.env.COUNCIL_DEBUG === "1",
  });
}
