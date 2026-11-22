import type { DataBlock } from "../prompts/common.js";
import { type PriorDecision, renderPrior } from "./prior.js";

/**
 * Пакет контекста от хоста. Участники сами исследуют проект, поэтому здесь только то, чего
 * в репозитории нет: ограничения и требования (notes), дифф (для review) и подсказки,
 * с каких файлов начать, включая прежние ADR по теме. Общий размер ограничен max_bytes.
 */

export interface ContextInput {
  notes?: string;
  diff?: string;
  files?: string[];
  /** Прежние ADR по близкой теме (находит ядро, не хост). */
  prior?: PriorDecision[];
  maxBytes?: number;
}

export const DEFAULT_MAX_BYTES = 120_000;

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const head = buf
    .subarray(0, Math.max(0, maxBytes - 200))
    .toString("utf8")
    .replace(/�$/, "");
  return `${head}\n…(обрезано: ${String(buf.length)} байт, лимит ${String(maxBytes)})`;
}

export function buildContext(input: ContextInput): DataBlock[] {
  const max = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const blocks: DataBlock[] = [];
  let left = max;
  const add = (name: string, content: string | undefined) => {
    if (content === undefined || content.trim() === "" || left <= 0) return;
    const text = truncate(content, left);
    left -= Buffer.byteLength(text, "utf8");
    blocks.push({ name, content: text });
  };
  add("notes", input.notes);
  add("prior_decisions", input.prior ? renderPrior(input.prior) : undefined);
  if (input.files && input.files.length > 0) {
    add("files", `С чего начать изучение:\n${input.files.map((f) => `- ${f}`).join("\n")}`);
  }
  add("diff", input.diff);
  return blocks;
}
