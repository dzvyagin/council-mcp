import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { ensureStateDir } from "../state/dir.js";

/**
 * Передача одобренного плана в отдельный git worktree с веткой council/<id>: туда кладутся
 * PLAN.md и копия ADR, реализацию ведёт хост-агент там. Основная рабочая копия не меняется.
 * Git вызывается без оболочки, только командами worktree/rev-parse.
 */

const run = promisify(execFile);

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 60_000 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new WorktreeError(
      `git ${args[0] ?? ""}: ${(err.stderr ?? err.message).trim().split("\n").slice(-2).join(" ")}`,
    );
  }
}

export interface Handoff {
  worktreePath: string;
  branch: string;
  planPath: string;
}

export async function createWorktree(
  workspace: string,
  stateDir: string,
  id: string,
  files: { path: string; content: string }[],
): Promise<Handoff> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new WorktreeError(`недопустимый id: ${id}`);
  const root = await git(workspace, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new WorktreeError("рабочая папка — не git-репозиторий: handoff в worktree невозможен");
  });
  const head = await git(workspace, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new WorktreeError("в репозитории нет коммитов: worktree создаётся от HEAD");
  });
  const branch = `council/${id}`;
  const worktreePath = join(stateDir, "worktrees", id);
  // .council/ сам себя исключает из git — иначе worktree появится в основной копии как неотслеживаемый.
  await ensureStateDir(stateDir);
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, worktreePath, head]);
  for (const f of files) {
    const target = join(worktreePath, f.path);
    if (relative(worktreePath, target).startsWith(".."))
      throw new WorktreeError(`путь вне worktree: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, { flag: "wx" });
  }
  return { worktreePath, branch, planPath: join(worktreePath, "PLAN.md") };
}

export function renderPlan(d: {
  title: string;
  decision: string;
  runId: string;
  adrPath?: string;
  plan: { step: string; details: string; files: string[] }[];
  risks: { risk: string; severity: string }[];
  confirmation?: string;
}): string {
  const out = [
    `# План: ${d.title}`,
    "",
    `Решение совета (run ${d.runId}): ${d.decision}`,
    ...(d.adrPath
      ? ["", `ADR: \`${d.adrPath}\` (статус proposed — до реализации его утверждает человек)`]
      : []),
    "",
    "## Шаги",
    "",
  ];
  d.plan.forEach((p, i) => {
    out.push(`${String(i + 1)}. [ ] **${p.step}** — ${p.details}`);
    if (p.files.length > 0) out.push(`   Файлы: ${p.files.map((f) => `\`${f}\``).join(", ")}`);
  });
  if (d.plan.length === 0) out.push("Совет не предложил шагов — составьте план вручную.");
  if (d.risks.length > 0)
    out.push("", "## Риски", "", ...d.risks.map((r) => `- [${r.severity}] ${r.risk}`));
  if (d.confirmation) out.push("", "## Как проверить", "", d.confirmation);
  out.push(
    "",
    "Изменения ведутся в этой ветке; ревью диффа — `/council-develop`, финальная проверка — `/council-deliver`.",
  );
  return `${out.join("\n")}\n`;
}
