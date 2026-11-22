import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { seededRandom } from "../core/anonymize.js";
import type { CouncilConfig } from "../core/config.js";
import { buildContext } from "../core/context/builder.js";
import { deliberate } from "../core/deliberate.js";
import { CouncilSession } from "../core/engine.js";
import { noopSink } from "../core/events.js";
import { PERSONAS } from "../core/panel.js";
import type { ParticipantDriver } from "../core/participant.js";
import { newNonce } from "../core/prompts/common.js";
import { proposePrompt } from "../core/prompts/consensus.js";
import { TOOLS, type Proposal } from "../core/protocols/consensus-schemas.js";

/**
 * Eval: для каждой задачи — решение лучшей одиночной модели (одно место, тот же промпт
 * предложения) и решение совета (consensus). Пары — в случайном порядке A/B без пометок для
 * слепого сравнения человеком; ключ и цена (вызовы, токены, секунды) — в key.json.
 */

export interface EvalCase {
  id: string;
  title: string;
  question: string;
  notes: string;
  checklist: string[];
}

export function parseCase(id: string, text: string): EvalCase {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id;
  const sections = new Map<string, string>();
  for (const m of text.matchAll(/^##\s+(.+)\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)) {
    sections.set((m[1] ?? "").trim().toLowerCase(), (m[2] ?? "").trim());
  }
  const question = sections.get("вопрос") ?? "";
  if (!question) throw new Error(`${id}: нет раздела «## Вопрос»`);
  const notes = [...sections.entries()]
    .filter(([k]) => k !== "вопрос" && !k.startsWith("что проверить"))
    .map(([k, v]) => `${k[0]?.toUpperCase() ?? ""}${k.slice(1)}:\n${v}`)
    .join("\n\n");
  const checks = [...sections.entries()].find(([k]) => k.startsWith("что проверить"))?.[1] ?? "";
  return {
    id,
    title,
    question,
    notes,
    checklist: checks
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean),
  };
}

export interface SideMetrics {
  calls: number;
  tokens: number;
  seconds: number;
  status: string;
}

export interface EvalOptions {
  cases: string[];
  outDir: string;
  config: CouncilConfig;
  makeDriver: (config: CouncilConfig) => ParticipantDriver;
  /** Модель одиночного решения: по умолчанию chair из конфига, иначе первая модель. */
  baselineModel?: string;
  now?: () => number;
}

/** Ответ одиночной модели в общей для пары структуре разделов. */
export function singleMarkdown(title: string, p: Proposal): string {
  const out = [`# ${title}`, "", "## Решение", "", p.summary, "", "## Обоснование", "", p.design];
  if (p.alternatives.length > 0) {
    out.push(
      "",
      "## Рассмотренные варианты",
      "",
      ...p.alternatives.map((a) => `- \`${a.key}\` — ${a.summary}: ${a.why_not}`),
    );
  }
  if (p.risks.length > 0) {
    out.push(
      "",
      "## Последствия и риски",
      "",
      ...p.risks.map(
        (r) => `- [${r.severity}] ${r.risk}${r.mitigation ? ` → ${r.mitigation}` : ""}`,
      ),
    );
  }
  if (p.assumptions.length > 0)
    out.push("", "## Допущения", "", ...p.assumptions.map((a) => `- ${a}`));
  if (p.open_questions.length > 0)
    out.push("", "## Открытые вопросы", "", ...p.open_questions.map((q) => `- ${q}`));
  return `${out.join("\n")}\n`;
}

/**
 * ADR совета → та же структура разделов без признаков авторства: без статуса, даты, «Решают»,
 * ссылки на транскрипт, таблицы участников и пометок «за: A, B».
 */
export function councilMarkdown(title: string, adr: string): string {
  const sections = new Map<string, string>();
  for (const m of adr.matchAll(/^(#{2,3}) (.+)\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/gm)) {
    sections.set((m[2] ?? "").trim(), (m[3] ?? "").trim());
  }
  const keep: [string, string][] = [
    ["Решение", "Решение"],
    ["Обоснование", "Обоснование"],
    ["Рассмотренные варианты", "Рассмотренные варианты"],
    ["Последствия и риски", "Последствия и риски"],
    ["План работ", "План работ"],
    ["Подтверждение", "Как проверить"],
    ["Плюсы и минусы вариантов", "Плюсы и минусы вариантов"],
    ["Когда пересмотреть", "Когда пересмотреть"],
    ["Особое мнение", "Возражения"],
    ["Открытые вопросы", "Открытые вопросы"],
  ];
  const out = [`# ${title}`];
  for (const [from, to] of keep) {
    const body = (sections.get(from) ?? "").replace(/ \(за: [^)]*\)/g, "").trim();
    if (
      !body ||
      /^(Нет: решение единогласно\.|Способ проверки совет не предложил|Существенных рисков совет не отметил)/.test(
        body,
      ) ||
      body === "—"
    )
      continue;
    out.push("", `## ${to}`, "", body);
  }
  return `${out.join("\n")}\n`;
}

async function single(
  c: EvalCase,
  o: EvalOptions,
): Promise<{ text: string; metrics: SideMetrics }> {
  const now = o.now ?? Date.now;
  const model =
    o.config.models.find((m) => m.id === (o.baselineModel ?? o.config.chair)) ?? o.config.models[0];
  if (!model) throw new Error("нет моделей");
  const architect = PERSONAS.architect;
  if (!architect) throw new Error("нет персоны architect");
  const driver = o.makeDriver(o.config);
  const started = now();
  const session = new CouncilSession({
    driver,
    seats: [{ persona: architect, model }],
    tools: [TOOLS.proposal],
    seed: `eval:${c.id}`,
    roundTimeoutS: o.config.participant.roundTimeoutS,
    emit: noopSink,
    signal: new AbortController().signal,
  });
  try {
    const nonce = newNonce();
    const answers = await session.askAll("propose", () => ({
      tool: TOOLS.proposal,
      prompt: proposePrompt(
        {
          question: c.question,
          context: buildContext({ notes: c.notes }),
          nonce,
          role: "архитектор — даёт полное решение задачи",
        },
        TOOLS.proposal.name,
      ),
    }));
    const p = [...answers.values()][0];
    const u = session.usage;
    return {
      text: p ? singleMarkdown(c.title, p) : `# ${c.title}\n\nОдиночная модель не дала ответа.\n`,
      metrics: {
        calls: u.calls,
        tokens: u.inputTokens + u.outputTokens,
        seconds: Math.round((now() - started) / 1000),
        status: p ? "ok" : "failed",
      },
    };
  } finally {
    await session.close();
    await driver.dispose();
  }
}

async function council(
  c: EvalCase,
  o: EvalOptions,
): Promise<{ text: string; metrics: SideMetrics }> {
  const now = o.now ?? Date.now;
  // ADR и транскрипт — во временную папку, не в проект.
  const scratch = await mkdtemp(join(tmpdir(), "council-eval-"));
  const config: CouncilConfig = {
    ...o.config,
    paths: { adrDir: join(scratch, "adr"), stateDir: join(scratch, "state") },
  };
  const driver = o.makeDriver(config);
  const started = now();
  try {
    const r = await deliberate(
      {
        mode: "consensus",
        question: c.question,
        notes: c.notes,
        adrTitle: c.title,
        confirmBudget: true,
      },
      { config, driver, runId: `eval-${c.id}`, ...(o.now && { now: o.now }) },
    );
    const adr = r.adr_path
      ? await readFile(join(config.workspace, r.adr_path), "utf8").catch(() => undefined)
      : undefined;
    const text = adr
      ? councilMarkdown(c.title, adr)
      : `# ${c.title}\n\n## Решение\n\n${r.decision || "Решения нет."}\n${r.dissent ? `\n## Возражения\n\n${r.dissent}\n` : ""}`;
    return {
      text,
      metrics: {
        calls: r.usage.calls,
        tokens: r.usage.prompt_tokens + r.usage.completion_tokens,
        seconds: Math.round((now() - started) / 1000),
        status: r.status,
      },
    };
  } finally {
    await driver.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface EvalSummary {
  cases: { id: string; title: string; single: SideMetrics; council: SideMetrics }[];
}

export async function runEval(o: EvalOptions): Promise<EvalSummary> {
  const summary: EvalSummary = { cases: [] };
  await mkdir(o.outDir, { recursive: true });
  for (const file of o.cases) {
    const id = basename(file).replace(/\.md$/, "");
    const c = parseCase(id, await readFile(file, "utf8"));
    const s = await single(c, o);
    const k = await council(c, o);
    // Порядок A/B — случайный, но воспроизводимый по id задачи.
    const councilFirst = seededRandom(`eval:${id}`)() < 0.5;
    const dir = join(o.outDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "A.md"), councilFirst ? k.text : s.text);
    await writeFile(join(dir, "B.md"), councilFirst ? s.text : k.text);
    await writeFile(
      join(dir, "checklist.md"),
      [
        `# Оценка: ${c.title}`,
        "",
        "Сравните A.md и B.md, не заглядывая в key.json. Для каждого пункта отметьте, какой ответ лучше (A, B или =).",
        "",
        "| Пункт | Лучше |",
        "| --- | --- |",
        "| Учтены ограничения задачи | |",
        "| Найдены риски | |",
        "| Решение проверяемо (как убедиться, что работает) | |",
        ...c.checklist.map((x) => `| ${x.replace(/\|/g, "\\|")} | |`),
        "| **Итог: какой ответ вы бы взяли** | |",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "key.json"),
      `${JSON.stringify({ A: councilFirst ? "council" : "single", B: councilFirst ? "single" : "council", single: s.metrics, council: k.metrics }, null, 2)}\n`,
    );
    summary.cases.push({ id, title: c.title, single: s.metrics, council: k.metrics });
  }
  await writeFile(join(o.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function listCases(dir: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}
