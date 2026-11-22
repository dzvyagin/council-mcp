import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CouncilConfig } from "../../core/config.js";
import type { Check } from "../../core/doctor.js";
import { ProfileError, resolveProfile } from "./profiles.js";

const run = promisify(execFile);

/** Проверка агента-участника: найден ли он и подходит ли версия (opencode — нужен V2). */
export async function checkAgent(config: CouncilConfig): Promise<Check[]> {
  let profile;
  try {
    profile = resolveProfile(config);
  } catch (e) {
    if (e instanceof ProfileError) return [{ name: "участники", level: "fail", detail: e.message }];
    throw e;
  }
  if (profile.kind !== "opencode")
    return [{ name: "участники", level: "ok", detail: `${profile.label} (ACP-агент из конфига)` }];
  try {
    const { stdout } = await run("opencode", ["--version"], { timeout: 15_000 });
    // Вывод бывает «2.3.2», «v2.3.2» или «opencode v2.3.2».
    const version = parseVersion(stdout) ?? stdout.trim();
    const major = Number(version.split(".")[0]);
    return Number.isFinite(major) && major >= 2
      ? [{ name: "участники", level: "ok", detail: `opencode acp · v${version}` }]
      : [
          {
            name: "участники",
            level: "fail",
            detail: `opencode v${version}: нужен opencode V2 (npm i -g @opencode/cli)`,
          },
        ];
  } catch {
    return [
      {
        name: "участники",
        level: "warn",
        detail: "opencode найден, но версию определить не удалось",
      },
    ];
  }
}

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}
