import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ensureStateDir } from "../state/dir.js";
import { readDecisions, readJson, withLock, writeAtomic } from "../state/files.js";

/**
 * Состояние процессов Double Diamond: `.council/workflows/<id>.json` — источник правды,
 * `.council/STATE.md` — человекочитаемая сводка активного процесса (пересобирается при каждом
 * изменении, переживает перезапуск хоста). По образцу `.octo/STATE.md` из Claude Octopus.
 */

export const PHASES = ["discover", "define", "develop", "deliver"] as const;
export type Phase = (typeof PHASES)[number];
export const AUTONOMY = ["supervised", "semi", "auto"] as const;
export type Autonomy = (typeof AUTONOMY)[number];

export interface PhaseRecord {
  status: "pending" | "running" | "passed" | "failed" | "overridden";
  run_id?: string;
  gate?: { passed: boolean; reason: string; score?: number };
  summary?: string;
  adr_path?: string;
  plan_path?: string;
  worktree_path?: string;
  branch?: string;
  override_reason?: string;
  updated?: string;
}

export interface WorkflowState {
  id: string;
  task: string;
  autonomy: Autonomy;
  created: string;
  updated: string;
  phase: Phase | "done";
  status: "ready" | "running" | "gate_failed" | "done" | "aborted";
  phases: Record<Phase, PhaseRecord>;
  context: { files?: string[]; notes?: string };
  /** Итог discover — общий контекст для следующих фаз. */
  research?: string;
  history: { ts: string; phase: string; event: string; note?: string }[];
}

const PHASE_TITLE: Record<Phase, string> = {
  discover: "Discover — исследование",
  define: "Define — решение и план",
  develop: "Develop — реализация (пишет хост-агент)",
  deliver: "Deliver — финальная проверка",
};

export const phaseIndex = (p: Phase | "done"): number =>
  p === "done" ? PHASES.length : PHASES.indexOf(p);

export class WorkflowStore {
  constructor(private readonly stateDir: string) {}

  private dir(): string {
    return join(this.stateDir, "workflows");
  }

  path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  async load(id: string): Promise<WorkflowState | undefined> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
    return readJson<WorkflowState | undefined>(this.path(id), undefined);
  }

  async list(): Promise<WorkflowState[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir())).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const all = await Promise.all(
      files.map((f) => readJson<WorkflowState | undefined>(join(this.dir(), f), undefined)),
    );
    return all
      .filter((w): w is WorkflowState => w !== undefined)
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Активный процесс: последний изменённый, который не завершён и не прерван. */
  async active(): Promise<WorkflowState | undefined> {
    const all = await this.list();
    return all.find((w) => w.status !== "done" && w.status !== "aborted") ?? all[0];
  }

  async save(state: WorkflowState): Promise<void> {
    await withLock(this.path(state.id), async () => {
      await ensureStateDir(this.stateDir);
      await mkdir(this.dir(), { recursive: true });
      await writeAtomic(this.path(state.id), `${JSON.stringify(state, null, 2)}\n`);
    });
    await this.renderStateMd();
  }

  async renderStateMd(): Promise<void> {
    const path = join(this.stateDir, "STATE.md");
    await withLock(path, async () => {
      const active = await this.active();
      const decisions = (await readDecisions(this.stateDir)).slice(-5).reverse();
      await writeAtomic(path, renderState(active, decisions));
    });
  }
}

export function renderState(
  w: WorkflowState | undefined,
  decisions: {
    run_id: string;
    status: string;
    score: number;
    adr_path?: string;
    question: string;
  }[],
): string {
  const out = ["# Council · состояние", ""];
  if (!w) {
    out.push("Активного процесса нет. Запустите `/council-embrace <задача>`.");
  } else {
    const n = Math.min(phaseIndex(w.phase) + 1, PHASES.length);
    out.push(
      `- Процесс: \`${w.id}\` — ${w.task.replace(/\s+/g, " ").slice(0, 200)}`,
      `- Фаза: ${w.phase === "done" ? "завершён" : `${w.phase} (${String(n)}/${String(PHASES.length)})`} · статус: ${w.status} · autonomy: ${w.autonomy}`,
    );
    const wt = PHASES.map((p) => w.phases[p]).find((r) => r.worktree_path);
    if (wt?.worktree_path)
      out.push(
        `- Worktree: \`${wt.worktree_path}\` (ветка \`${wt.branch ?? "?"}\`), план: \`${wt.plan_path ?? "PLAN.md"}\``,
      );
    out.push("", "## Гейты", "");
    for (const p of PHASES) {
      const r = w.phases[p];
      const mark = {
        pending: "·",
        running: "…",
        passed: "✓",
        failed: "✗",
        overridden: "✓ вручную",
      }[r.status];
      const gate = r.gate ? ` — ${r.gate.reason}` : "";
      const run = r.run_id ? ` (run ${r.run_id})` : "";
      out.push(
        `- ${mark} ${PHASE_TITLE[p]}${gate}${run}${r.override_reason ? ` — решение человека: ${r.override_reason}` : ""}`,
      );
    }
    out.push("", "## История", "");
    for (const h of w.history.slice(-15))
      out.push(`- [${h.ts}] ${h.phase}: ${h.event}${h.note ? ` — ${h.note}` : ""}`);
  }
  if (decisions.length > 0) {
    out.push("", "## Последние решения", "");
    for (const d of decisions) {
      out.push(
        `- ${d.adr_path ? `\`${d.adr_path}\`` : d.run_id} — ${d.question.slice(0, 100)} (${d.status}, ${d.score.toFixed(2)})`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
