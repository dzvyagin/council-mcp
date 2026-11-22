import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Прежние решения по теме: ADR из docs/adr, похожие на вопрос. Совет получает их список
 * (путь, заголовок, статус) и сам читает файлы — чтобы не противоречить прошлым решениям
 * молча, а ссылаться на них или явно пересматривать. Без модели: пересечение основ слов
 * вопроса с заголовком и разделом «Решение».
 */

export interface PriorDecision {
  path: string;
  title: string;
  status: string;
}

const STOP = new Set([
  "котор",
  "нужно",
  "можно",
  "какой",
  "какую",
  "какие",
  "будет",
  "чтобы",
  "через",
  "после",
  "перед",
  "между",
  "вопрос",
  "решен",
  "решит",
  "сделат",
  "выбра",
  "лучше",
  "should",
  "which",
  "about",
  "would",
]);

/** Основы слов: первые 6 символов слов длиной ≥ 4 (грубый стемминг для русского и английского). */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 4) continue;
    const s = w.slice(0, 6);
    if (!STOP.has(s) && !STOP.has(s.slice(0, 5))) out.add(s);
  }
  return out;
}

function section(text: string, heading: string): string {
  const m = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
  return m?.[1] ?? "";
}

export async function findPriorDecisions(
  adrDir: string,
  workspace: string,
  question: string,
  limit = 3,
): Promise<PriorDecision[]> {
  let files: string[];
  try {
    files = (await readdir(adrDir)).filter((f) => /^\d{4}-.+\.md$/.test(f)).sort();
  } catch {
    return [];
  }
  const q = stems(question);
  if (q.size === 0) return [];
  const scored: (PriorDecision & { score: number; order: number })[] = [];
  for (const [order, f] of files.entries()) {
    const text = await readFile(join(adrDir, f), "utf8").catch(() => "");
    const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? f;
    const status =
      /^- Статус:\s*([\p{L}-]+)/mu.exec(text)?.[1] ??
      /^status:\s*([\p{L}-]+)/imu.exec(text)?.[1] ??
      "unknown";
    const titleStems = stems(title);
    const bodyStems = stems(section(text, "Решение").slice(0, 2000));
    let score = 0;
    for (const s of q) score += titleStems.has(s) ? 2 : bodyStems.has(s) ? 1 : 0;
    if (score >= 2)
      scored.push({ path: relative(workspace, join(adrDir, f)), title, status, score, order });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.order - a.order)
    .slice(0, limit)
    .map(({ path, title, status }) => ({ path, title, status }));
}

export function renderPrior(prior: PriorDecision[]): string | undefined {
  if (prior.length === 0) return undefined;
  return [
    "Прежние решения совета по близкой теме — прочитай их. Не противоречь им молча: опирайся на них или прямо скажи, что предлагаешь пересмотреть ADR, и почему.",
    ...prior.map((p) => `- ${p.path} — ${p.title} (статус: ${p.status})`),
  ].join("\n");
}
