import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Mode, RunStatus } from "../types.js";

/**
 * ADR по шаблону на основе MADR 4.0 (adr.github.io/madr) с добавками совета: особое мнение,
 * риски, открытые вопросы, метаданные запуска. Номер = максимальный в папке + 1; существующие
 * файлы никогда не перезаписываются. Статус всегда proposed — решение принимает человек.
 * Имён моделей в ADR нет: файл коммитится, участники — только под метками.
 */

export interface AdrOption {
  key: string;
  summary: string;
  supporters: string[];
  pros: string[];
  cons: string[];
}

export interface AdrParticipant {
  alias: string;
  role?: string;
  position?: string;
  confidence?: number;
  state: string;
  note?: string;
}

export interface AdrData {
  title: string;
  date: string;
  runId: string;
  mode: Mode;
  transcript: string;
  status: RunStatus;
  score: number;
  gate: { threshold: number; passed: boolean };
  question: string;
  notes?: string;
  decision: string;
  decisionKey?: string;
  rationale?: string;
  options: AdrOption[];
  rejected: { key: string; why: string }[];
  risks: { risk: string; severity: string; mitigation?: string | undefined }[];
  confirmation?: string;
  plan?: { step: string; details: string; files: string[] }[];
  veto?: { persona: string; reason: string };
  dissent?: string;
  openQuestions: string[];
  participants: AdrParticipant[];
  warnings: string[];
}

const CYR: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function slugify(text: string, max = 50): string {
  const latin = text.toLowerCase().replace(/[а-яё]/g, (c) => CYR[c] ?? c);
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/, "");
}

const ADR_FILE = /^(\d{4})-.+\.md$/;

export async function nextAdrNumber(dir: string): Promise<number> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const numbers = files
    .map((f) => ADR_FILE.exec(f)?.[1])
    .filter((n) => n !== undefined)
    .map(Number);
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

const STATUS_TEXT: Record<RunStatus, string> = {
  converged: "единогласно",
  majority: "большинство",
  no_consensus: "консенсус не достигнут",
  vetoed: "вето",
  quorum_failed: "нет кворума",
  tie: "голоса разделились",
  partial: "частичный итог",
  failed: "сбой",
};

const bullets = (items: string[], empty = "—") =>
  items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const cell = (s: string) => oneLine(s).replace(/\|/g, "\\|");

export function renderAdr(number: number, d: AdrData): string {
  const id = String(number).padStart(4, "0");
  const gate = `гейт ${d.gate.threshold.toFixed(2)} ${d.gate.passed ? "пройден" : "не пройден"}`;
  const out: string[] = [
    `# ${id}. ${oneLine(d.title)}`,
    "",
    d.veto
      ? `- Статус: rejected (council: vetoed — вето ${d.veto.persona}: ${oneLine(d.veto.reason)})`
      : `- Статус: proposed (council: ${d.status} — ${STATUS_TEXT[d.status]}, score ${d.score.toFixed(2)}, ${gate})`,
    `- Дата: ${d.date}`,
    "- Решают: команда; совет даёт рекомендацию, решение принимает человек",
    `- Run: \`${d.transcript}\` (${d.mode}, run ${d.runId})`,
    "",
    "## Контекст и постановка задачи",
    "",
    d.question.trim(),
  ];
  if (d.notes?.trim()) out.push("", "Ограничения и требования:", "", d.notes.trim());

  out.push("", "## Рассмотренные варианты", "");
  out.push(
    d.options.length > 0
      ? d.options
          .map(
            (o) =>
              `- \`${o.key}\` — ${oneLine(o.summary)}${o.supporters.length > 0 ? ` (за: ${o.supporters.join(", ")})` : ""}`,
          )
          .join("\n")
      : "—",
  );
  for (const r of d.rejected.filter((r) => !d.options.some((o) => o.key === r.key))) {
    out.push(`- \`${r.key}\` — отвергнут: ${oneLine(r.why)}`);
  }

  out.push("", "## Решение", "");
  out.push(
    d.decisionKey
      ? `Выбран вариант \`${d.decisionKey}\`: ${d.decision.trim()}`
      : d.decision.trim() || "Решение не принято.",
  );
  if (d.rationale?.trim()) out.push("", "### Обоснование", "", d.rationale.trim());

  out.push("", "### Последствия и риски", "");
  out.push(
    bullets(
      d.risks.map(
        (r) =>
          `[${r.severity}] ${oneLine(r.risk)}${r.mitigation ? ` → ${oneLine(r.mitigation)}` : ""}`,
      ),
      "Существенных рисков совет не отметил.",
    ),
  );
  out.push(
    "",
    "### Подтверждение",
    "",
    d.confirmation?.trim() || "Способ проверки совет не предложил — определите при ревью ADR.",
  );

  if (d.plan && d.plan.length > 0) {
    out.push("", "## План работ", "");
    d.plan.forEach((p, i) => {
      out.push(`${String(i + 1)}. **${oneLine(p.step)}** — ${oneLine(p.details)}`);
      if (p.files.length > 0) out.push(`   Файлы: ${p.files.map((f) => `\`${f}\``).join(", ")}`);
    });
  }

  const detailed = d.options.filter((o) => o.pros.length > 0 || o.cons.length > 0);
  if (detailed.length > 0) {
    out.push("", "## Плюсы и минусы вариантов");
    for (const o of detailed) {
      out.push("", `### \`${o.key}\``, "");
      out.push(
        ...o.pros.map((p) => `- Хорошо: ${oneLine(p)}`),
        ...o.cons.map((c) => `- Плохо: ${oneLine(c)}`),
      );
    }
  }

  out.push("", "## Особое мнение", "", d.dissent?.trim() || "Нет: решение единогласно.");
  out.push("", "## Открытые вопросы", "", bullets(d.openQuestions.map(oneLine)));

  out.push(
    "",
    "## Совет",
    "",
    "| Участник | Роль | Позиция | Уверенность | Состояние |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const p of d.participants) {
    const state = p.state === "ok" ? "ok" : `${p.state}${p.note ? ` (${cell(p.note)})` : ""}`;
    out.push(
      `| ${p.alias} | ${cell(p.role ?? "—")} | ${p.position ? `\`${p.position}\`` : "—"} | ${p.confidence?.toFixed(2) ?? "—"} | ${state} |`,
    );
  }
  if (d.warnings.length > 0) out.push("", ...d.warnings.map((w) => `> ⚠ ${oneLine(w)}`));
  return `${out.join("\n")}\n`;
}

const INDEX_MARKER = "<!-- council:adr-index -->";

/** Индекс ведём, только если README создан советом (есть маркер); чужой README не трогаем. */
async function updateIndex(dir: string, file: string, number: number, d: AdrData): Promise<void> {
  const path = join(dir, "README.md");
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const row = `| [${String(number).padStart(4, "0")}](${file}) | ${cell(d.title)} | ${d.veto ? "rejected" : "proposed"} (${d.status}) | ${d.date} |`;
  if (text === undefined) {
    const head = [
      "# Архитектурные решения",
      "",
      INDEX_MARKER,
      "",
      "| № | Решение | Статус | Дата |",
      "| --- | --- | --- | --- |",
    ];
    await writeFile(path, `${[...head, row].join("\n")}\n`, { flag: "wx" }).catch(() => undefined);
    return;
  }
  if (text.includes(INDEX_MARKER)) await writeFile(path, `${text.trimEnd()}\n${row}\n`, "utf8");
}

export interface WrittenAdr {
  path: string;
  number: number;
}

/** Пишет новый ADR. Гонка за номер решается флагом wx: при EEXIST берём следующий номер. */
export async function writeAdr(dir: string, d: AdrData): Promise<WrittenAdr> {
  await mkdir(dir, { recursive: true });
  const slug = slugify(d.title) || slugify(d.decisionKey ?? "") || "decision";
  for (let number = await nextAdrNumber(dir), tries = 0; tries < 100; number++, tries++) {
    const file = `${String(number).padStart(4, "0")}-${slug}.md`;
    try {
      await writeFile(join(dir, file), renderAdr(number, d), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    // Параллельный запуск мог занять тот же номер с другим slug: уступает файл с большим именем.
    const prefix = `${String(number).padStart(4, "0")}-`;
    const rivals = (await readdir(dir)).filter(
      (f) => f.startsWith(prefix) && f !== file && f < file,
    );
    if (rivals.length > 0) {
      await rm(join(dir, file), { force: true });
      continue;
    }
    await updateIndex(dir, file, number, d);
    return { path: join(dir, file), number };
  }
  throw new Error(`не удалось подобрать свободный номер ADR в ${dir}`);
}
