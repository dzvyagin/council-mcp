import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { ensureStateDir } from "./dir.js";
import { writeAtomic } from "./files.js";

/**
 * Реестр открытых вопросов: `.council/OPEN.md` — открытые вопросы и риски critical/major из
 * действующих ADR (не rejected, не superseded) в одном списке. Источник правды — сами ADR:
 * реестр пересобирается после каждого ADR, закрыть пункт — убрать его из ADR или сменить
 * статус ADR. Счётчики попадают в сводку состояния совета (системный промпт хоста).
 */

export interface OpenItem {
  adr: string;
  number: string;
  text: string;
}

export interface OpenRegistry {
  questions: OpenItem[];
  risks: OpenItem[];
}

const CLOSED = /^(rejected|superseded|deprecated|отклон|заменён|устарел)/i;

function sectionBullets(text: string, heading: RegExp): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return [];
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const h = /^(#+) /.exec(line);
    if (h && (h[1]?.length ?? 0) <= level) break;
    const b = /^- (.+)$/.exec(line);
    if (b?.[1]) out.push(b[1].trim());
  }
  return out;
}

export async function collectOpen(adrDir: string): Promise<OpenRegistry> {
  const registry: OpenRegistry = { questions: [], risks: [] };
  let files: string[];
  try {
    files = (await readdir(adrDir)).filter((f) => /^\d{4}-.+\.md$/.test(f)).sort();
  } catch {
    return registry;
  }
  for (const f of files) {
    const text = await readFile(join(adrDir, f), "utf8").catch(() => "");
    const status = /^- Статус:\s*(\S+)/m.exec(text)?.[1] ?? /^status:\s*(\S+)/im.exec(text)?.[1];
    if (status && CLOSED.test(status)) continue;
    const number = f.slice(0, 4);
    for (const q of sectionBullets(text, /^## Открытые вопросы\s*$/))
      registry.questions.push({ adr: f, number, text: q });
    for (const r of sectionBullets(text, /^#{2,3} Последствия и риски\s*$/)) {
      if (/^\[(critical|major)\]/i.test(r)) registry.risks.push({ adr: f, number, text: r });
    }
  }
  return registry;
}

export function renderOpen(r: OpenRegistry, adrLink: (file: string) => string): string {
  const item = (i: OpenItem) => `- ${i.text} — [ADR ${i.number}](${adrLink(i.adr)})`;
  return [
    "# Открытые вопросы и риски совета",
    "",
    "Собрано из действующих ADR (все, кроме rejected и superseded); пересобирается после каждого решения совета. Закрыть пункт — убрать его из ADR или сменить статус ADR.",
    "",
    "## Открытые вопросы",
    "",
    ...(r.questions.length > 0 ? r.questions.map(item) : ["Нет."]),
    "",
    "## Риски critical и major",
    "",
    ...(r.risks.length > 0 ? r.risks.map(item) : ["Нет."]),
    "",
  ].join("\n");
}

/** Пересобрать `.council/OPEN.md` по текущим ADR. */
export async function rebuildOpen(adrDir: string, stateDir: string): Promise<OpenRegistry> {
  const registry = await collectOpen(adrDir);
  await ensureStateDir(stateDir);
  await writeAtomic(
    join(stateDir, "OPEN.md"),
    renderOpen(registry, (file) => relative(stateDir, join(adrDir, file)).split("\\").join("/")),
  );
  return registry;
}

/** Короткая строка для сводки состояния: число пунктов и первые два вопроса. */
export async function openSummary(adrDir: string, openPath: string): Promise<string | undefined> {
  const r = await collectOpen(adrDir);
  if (r.questions.length === 0 && r.risks.length === 0) return undefined;
  const top = r.questions
    .slice(0, 2)
    .map((q) => `${q.text.slice(0, 100)} (ADR ${q.number})`)
    .join("; ");
  return `Открыто по решениям совета: вопросов ${String(r.questions.length)}, рисков critical/major ${String(r.risks.length)} — ${openPath}.${top ? ` Например: ${top}.` : ""}`;
}
