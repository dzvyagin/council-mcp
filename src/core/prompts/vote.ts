import { buildPrompt, type DataBlock } from "./common.js";

export interface VotePromptInput {
  question: string;
  /** Варианты в порядке, перемешанном для этого участника. */
  options?: string[];
  notes?: string;
  files?: string[];
  role?: string;
  nonce: string;
  toolName: string;
}

export function votePrompt(input: VotePromptInput): string {
  const task: string[] = [
    "Проголосуй по вопросу ниже. Это быстрое голосование: изучи проект ровно настолько, чтобы обоснованно выбрать.",
  ];
  if (input.options && input.options.length > 0) {
    task.push(
      "Выбери ровно один вариант из блока OPTIONS и передай в поле choice его текст без изменений.",
    );
  } else {
    task.push(
      "Вариантов нет: сформулируй свой выбор коротким ключом латиницей в kebab-case (например, pg-partition-by-month).",
    );
  }
  task.push(
    "confidence — уверенность от 0 до 1. rationale — до пяти предложений с опорой на факты из проекта.",
  );

  const data: DataBlock[] = [{ name: "question", content: input.question }];
  if (input.options && input.options.length > 0) {
    data.push({
      name: "options",
      content: input.options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
    });
  }
  if (input.notes) data.push({ name: "notes", content: input.notes });
  if (input.files && input.files.length > 0) {
    data.push({ name: "files", content: `С чего начать изучение:\n${input.files.join("\n")}` });
  }

  return buildPrompt({
    ...(input.role !== undefined && { role: input.role }),
    task: task.join("\n"),
    data,
    toolName: input.toolName,
    nonce: input.nonce,
  });
}
