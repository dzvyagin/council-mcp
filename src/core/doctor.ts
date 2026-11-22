import { execFile } from "node:child_process";
import { access, constants, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { CouncilConfig } from "./config.js";
import { probeEndpoint } from "./endpoint.js";

/**
 * Диагностика: конфиг, эндпоинт и модели, агент-участник, окружение (ripgrep, git), права
 * на запись в docs/adr и .council. Используется CLI `council doctor` и MCP `council_doctor`.
 */

export interface Check {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorDeps {
  fetch?: typeof fetch;
  /** Проверка агента-участника (в core нет знаний об ACP-драйвере). */
  checkAgent: (config: CouncilConfig) => Promise<Check[]>;
  which: (command: string) => string | undefined;
}

const run = promisify(execFile);

async function writable(path: string): Promise<{ ok: boolean; where: string }> {
  // Ближайший существующий предок должен быть доступен на запись.
  let p = path;
  for (;;) {
    try {
      await stat(p);
      await access(p, constants.W_OK);
      return { ok: true, where: p };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, where: p };
      const parent = dirname(p);
      if (parent === p) return { ok: false, where: p };
      p = parent;
    }
  }
}

export async function runDoctor(config: CouncilConfig, deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({
    name: "конфиг",
    level: "ok",
    detail: `${config.configPath ?? "только env"} · модели: ${config.models.map((m) => m.id).join(", ")} · panel ${String(config.defaults.panel)} · style ${config.defaults.style}`,
  });

  const probe = await probeEndpoint(config, deps.fetch ?? fetch);
  if (!probe.ok) {
    // /models есть не у всех провайдеров: недоступность списка — предупреждение, сеть/ключ — ошибка.
    const soft = /HTTP 404|HTTP 405|нет поля data|не JSON/.test(probe.error);
    checks.push({
      name: "эндпоинт",
      level: soft ? "warn" : "fail",
      detail: `${config.endpoint.baseUrl}: ${probe.error}`,
    });
  } else {
    checks.push({
      name: "эндпоинт",
      level: "ok",
      detail: `${config.endpoint.baseUrl}: доступен, моделей ${String(probe.models.length)}`,
    });
    for (const m of config.models) {
      const found = probe.models.find((p) => p.id === m.id);
      const ctx =
        found?.context !== undefined
          ? ` · контекст ${String(found.context)} (в конфиге ${String(m.context)})`
          : "";
      checks.push(
        found
          ? {
              name: `модель ${m.id}`,
              level: found.context !== undefined && found.context < m.context ? "warn" : "ok",
              detail: `есть в /models${ctx}`,
            }
          : { name: `модель ${m.id}`, level: "fail", detail: "нет в списке /models" },
      );
    }
  }

  checks.push(...(await deps.checkAgent(config)));

  checks.push(
    deps.which("rg")
      ? { name: "ripgrep", level: "ok", detail: "есть в PATH" }
      : {
          name: "ripgrep",
          level: "warn",
          detail:
            "нет в PATH: opencode попытается скачать его с github.com — в закрытом контуре установите rg заранее",
        },
  );

  if (deps.which("git")) {
    try {
      await run("git", ["rev-parse", "--show-toplevel"], {
        cwd: config.workspace,
        timeout: 15_000,
      });
      checks.push({
        name: "git",
        level: "ok",
        detail: "репозиторий найден (нужен для handoff в worktree)",
      });
    } catch {
      checks.push({
        name: "git",
        level: "warn",
        detail: "рабочая папка — не git-репозиторий: handoff plan-only и Double Diamond недоступны",
      });
    }
  } else {
    checks.push({
      name: "git",
      level: "warn",
      detail: "git не найден: handoff plan-only и Double Diamond недоступны",
    });
  }

  for (const [name, path] of [
    ["docs/adr", config.paths.adrDir],
    [".council", config.paths.stateDir],
  ] as const) {
    const w = await writable(path);
    checks.push({
      name: `запись в ${name}`,
      level: w.ok ? "ok" : "fail",
      detail: w.ok ? path : `нет прав на запись: ${w.where}`,
    });
  }

  const ignored = await readFile(join(config.workspace, ".gitignore"), "utf8").then(
    (t) => t.split(/\r?\n/).some((l) => /^\/?\.council\/?$/.test(l.trim())),
    () => false,
  );
  const selfIgnored = await readFile(join(config.paths.stateDir, ".gitignore"), "utf8").then(
    (t) => t.trim() === "*",
    () => false,
  );
  checks.push(
    ignored || selfIgnored
      ? {
          name: ".council в git",
          level: "ok",
          detail: ignored ? "исключён в .gitignore" : "исключён через .council/.gitignore",
        }
      : {
          name: ".council в git",
          level: "warn",
          detail: "добавьте .council/ в .gitignore (council setup сделает это)",
        },
  );
  return checks;
}

export function renderDoctor(checks: Check[]): string {
  const mark = { ok: "✓", warn: "⚠", fail: "✗" } as const;
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  return [
    `🏛 Council · doctor · ${fails === 0 ? "готов к работе" : `ошибок: ${String(fails)}`}${warns > 0 ? ` · предупреждений: ${String(warns)}` : ""}`,
    ...checks.map((c) => `${mark[c.level]} ${c.name}: ${c.detail}`),
  ].join("\n");
}
