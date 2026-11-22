import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { DEFAULT_PROTECTED_PATHS } from "../core/config.js";
import { route, type Route } from "../core/router.js";
import { readDecisions } from "../core/state/files.js";
import { openSummary } from "../core/state/open.js";
import { WorkflowStore } from "../core/workflow/state.js";

/**
 * Логика плагина opencode (`src/opencode/plugin.ts`): защита путей, сводка состояния совета
 * для системного промпта, правило автозапуска и подсказка роутера.
 * Без зависимостей от MCP и ACP; читает только `council.config.json`, `docs/adr` и `.council`.
 */

export { route, type Route };

export interface ProjectSettings {
  protectedPaths: string[];
  adrDir: string;
  stateDir: string;
}

export async function projectSettings(projectDir: string): Promise<ProjectSettings> {
  let file: { protectedPaths?: unknown; paths?: { adrDir?: unknown; stateDir?: unknown } } = {};
  try {
    file = JSON.parse(
      await readFile(join(projectDir, "council.config.json"), "utf8"),
    ) as typeof file;
  } catch {
    // конфига нет — умолчания
  }
  const strings = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
  const str = (v: unknown, d: string) => (typeof v === "string" && v.length > 0 ? v : d);
  return {
    protectedPaths: strings(file.protectedPaths) ?? DEFAULT_PROTECTED_PATHS,
    adrDir: join(projectDir, str(file.paths?.adrDir, "docs/adr")),
    stateDir: join(projectDir, str(file.paths?.stateDir, ".council")),
  };
}

/** Глоб в RegExp: `**` — любые папки, `*` — в пределах папки, `?`, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      const slash = glob.charAt(i + 2) === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function protectedMatch(relPath: string, patterns: string[]): string | undefined {
  const p = relPath.split("\\").join("/").replace(/^\.\//, "");
  return patterns.find((g) => globToRegExp(g).test(p));
}

/** Пути из текста патча opencode (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`). */
export function patchPaths(patchText: string): string[] {
  return [
    ...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm),
  ]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter(Boolean);
}

/** Пути, которые правит вызов инструмента (edit, write — `path`; patch — из `patchText`). */
export function editedPaths(tool: string, input: unknown): string[] {
  const i = (input ?? {}) as { path?: unknown; filePath?: unknown; patchText?: unknown };
  if (tool === "patch" || tool === "apply_patch")
    return typeof i.patchText === "string" ? patchPaths(i.patchText) : [];
  if (tool === "edit" || tool === "write" || tool === "multiedit") {
    const p = i.path ?? i.filePath;
    return typeof p === "string" ? [p] : [];
  }
  return [];
}

/** ADR, в котором упомянут файл (путь от корня проекта или имя файла). */
export async function adrMentioning(adrDir: string, relPath: string): Promise<string | undefined> {
  let files: string[] = [];
  try {
    files = (await readdir(adrDir)).filter((f) => /^\d{4}-.+\.md$/.test(f));
  } catch {
    return undefined;
  }
  const name = relPath.split("/").at(-1) ?? relPath;
  for (const f of files) {
    const text = await readFile(join(adrDir, f), "utf8").catch(() => "");
    if (text.includes(relPath) || (name.length > 3 && text.includes(name))) return f;
  }
  return undefined;
}

export interface GuardDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Решение защиты путей: правка защищённого файла разрешена, если в этой сессии был запуск совета
 * или есть ADR, упоминающий файл. COUNCIL_GUARD=off — аварийное отключение.
 */
export async function guard(opts: {
  projectDir: string;
  tool: string;
  input: unknown;
  councilInSession: boolean;
  env?: Record<string, string | undefined>;
}): Promise<GuardDecision> {
  if ((opts.env ?? process.env).COUNCIL_GUARD === "off")
    return { allowed: true, reason: "COUNCIL_GUARD=off" };
  const paths = editedPaths(opts.tool, opts.input);
  if (paths.length === 0) return { allowed: true, reason: "не правка файла" };
  const settings = await projectSettings(opts.projectDir);
  for (const raw of paths) {
    const rel = raw.startsWith("/") ? relative(opts.projectDir, raw) : raw;
    if (rel.startsWith("..")) continue;
    const pattern = protectedMatch(rel, settings.protectedPaths);
    if (!pattern) continue;
    if (opts.councilInSession) continue;
    const adr = await adrMentioning(settings.adrDir, rel);
    if (adr) continue;
    return {
      allowed: false,
      reason: `нужно решение совета: «${rel}» — защищённый путь (${pattern}). Вызови @architect (или /council) и получи ADR, упоминающий этот файл. Аварийное отключение — COUNCIL_GUARD=off.`,
    };
  }
  return { allowed: true, reason: "разрешено" };
}

/** Короткая сводка для системного промпта: активный процесс и последние решения (≤ ~1 КБ). */
export async function councilSummary(projectDir: string): Promise<string | undefined> {
  const settings = await projectSettings(projectDir);
  const store = new WorkflowStore(settings.stateDir);
  const active = (await store.list()).find((w) => w.status !== "done" && w.status !== "aborted");
  const decisions = (await readDecisions(settings.stateDir))
    .filter((d) => d.adr_path)
    .slice(-3)
    .reverse();
  const open = await openSummary(
    settings.adrDir,
    relative(projectDir, join(settings.stateDir, "OPEN.md")).split("\\").join("/"),
  );
  if (!active && decisions.length === 0 && !open) return undefined;
  const lines = ["<council-state>"];
  if (active) {
    const gates = (["discover", "define", "develop", "deliver"] as const)
      .map(
        (p) =>
          `${p} ${{ pending: "·", running: "…", passed: "✓", failed: "✗", overridden: "✓*" }[active.phases[p].status]}`,
      )
      .join(", ");
    lines.push(
      `Активный процесс совета ${active.id}: ${active.task.replace(/\s+/g, " ").slice(0, 160)}`,
      `Фаза ${active.phase}, статус ${active.status}, autonomy ${active.autonomy}; гейты: ${gates}.`,
    );
    const define = active.phases.define;
    if (define.adr_path)
      lines.push(`Решение (define): ${define.summary?.slice(0, 200) ?? ""} — ${define.adr_path}`);
    if (define.worktree_path)
      lines.push(
        `Работа ведётся в worktree ${define.worktree_path} (ветка ${define.branch ?? "?"}), план — ${define.plan_path ?? "PLAN.md"}.`,
      );
    lines.push("Продолжай процесс через council_workflow (status — подробности).");
  }
  if (decisions.length > 0) {
    lines.push("Последние решения совета (ADR, статус proposed — утверждает человек):");
    for (const d of decisions)
      lines.push(`- ${d.adr_path ?? d.run_id}: ${d.question.slice(0, 100)} (${d.status})`);
  }
  if (open) lines.push(open);
  lines.push("</council-state>");
  return lines.join("\n");
}

/** Какой инструмент совета соответствует команде роутера. */
function toolFor(r: Route): string {
  switch (r.command) {
    case "council-embrace":
      return `council_workflow с action "start" и ${JSON.stringify(r.args)}`;
    case "council-status":
      return 'council_workflow с action "status"';
    case "council-usage":
      return "council_usage";
    case "council-costs":
      return `council_estimate с ${JSON.stringify(r.args)}`;
    default:
      return `council_deliberate с ${JSON.stringify(r.args)}`;
  }
}

/**
 * Подсказка роутера для обычного промпта. invoke (по умолчанию) — агент сам вызывает совет:
 * при высокой уверенности роутера — конкретный вызов, при средней — «проверь, подходит ли».
 * suggest — только предложить пользователю. В обоих случаях — «не подходит — игнорируй».
 */
export function routerHint(text: string, mode: string): string | undefined {
  if (mode === "off" || text.trim().startsWith("/")) return undefined;
  const r = route(text);
  if (r.command === "none" || r.confidence === "low") return undefined;
  const ignore = "Если запрос на самом деле не про это — игнорируй подсказку и отвечай как обычно.";
  if (mode === "suggest")
    return `<council-hint>Запрос похож на задачу для совета моделей (${r.reason}). Предложи пользователю одной строкой запустить совет (${toolFor(r)}), но не запускай без его согласия. ${ignore}</council-hint>`;
  return r.confidence === "high"
    ? `<council-hint>Запрос похож на задачу для совета моделей (${r.reason}). Вызови сам, не спрашивая пользователя: ${toolFor(r)}; контекст (ключевые файлы, ограничения) добавь в context. ${ignore}</council-hint>`
    : `<council-hint>Возможно, это ключевое решение (${r.reason}). Если задача меняет схему данных, контракты, публичное API, технологию или консистентность — вызови совет сам (${toolFor(r)}). ${ignore}</council-hint>`;
}

/**
 * Постоянное правило для системного промпта хоста (вместо фрагмента AGENTS.md): когда агент
 * сам зовёт совет. Отключение — COUNCIL_AUTO_ROUTER=off.
 */
export function autoRule(mode: string): string | undefined {
  if (mode === "off") return undefined;
  const how =
    mode === "suggest"
      ? "предложи пользователю запустить совет моделей и запусти после его согласия"
      : "сам, не спрашивая разрешения, вызови совет моделей";
  return [
    "<council-rule>",
    `Перед реализацией ${how} (MCP-сервер council: council_deliberate; режим подскажет council_route; сквозной процесс — council_workflow), если задача включает:`,
    "- изменение схемы БД, новую таблицу, миграцию данных;",
    "- новую границу сервиса или межсервисный контракт;",
    "- изменение публичного API;",
    "- выбор технологии, хранилища, брокера;",
    "- решения по транзакциям и консистентности;",
    "- или пользователь просит сравнить варианты либо принять архитектурное решение.",
    "Простые правки, багфиксы, тесты, рефакторинг без смены контрактов и вопросы по коду — без совета.",
    "Как вызывать — skill council. Решение совета (ADR со статусом proposed) покажи как есть; реализацию по нему начинай после подтверждения пользователя.",
    "</council-rule>",
  ].join("\n");
}
