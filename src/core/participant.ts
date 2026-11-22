import type { z } from "zod";

import type { ModelConfig } from "./config.js";

/**
 * Участник совета — агент, который читает проект и сдаёт ответ раунда через типизированный
 * инструмент. Ядро не знает, как участник запущен (ACP, in-process, фейк в тестах).
 */

export interface Usage {
  /** Число обращений к участнику (prompt-ходов), включая напоминания и повторы. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Инструмент, через который участник сдаёт ответ раунда. */
export interface AnswerTool<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T, Record<string, unknown>>;
}

export interface AskRequest<T> {
  /** Идентификатор раунда — для логов и транскрипта. */
  round: string;
  prompt: string;
  tool: AnswerTool<T>;
  timeoutS: number;
  signal?: AbortSignal;
}

export type ParticipantErrorKind =
  "timeout" | "no_answer" | "cancelled" | "agent_error" | "agent_exited" | "unsupported";

export class ParticipantError extends Error {
  readonly kind: ParticipantErrorKind;

  constructor(kind: ParticipantErrorKind, message: string) {
    super(message);
    this.name = "ParticipantError";
    this.kind = kind;
  }
}

export type AskResult<T> =
  | { ok: true; value: T; usage: Usage; transcript: string; durationMs: number }
  | { ok: false; error: ParticipantError; usage: Usage; transcript: string; durationMs: number };

export interface Participant {
  /** Анонимная метка (A, B, C…). */
  readonly alias: string;
  ask<T>(request: AskRequest<T>): Promise<AskResult<T>>;
  close(): Promise<void>;
}

export interface ParticipantSpec {
  alias: string;
  model: ModelConfig;
  /** Все инструменты ответа, которые понадобятся в запуске: регистрируются один раз при старте. */
  tools: AnswerTool[];
}

export interface ParticipantDriver {
  /** Короткое имя для отчётов и doctor (например, «opencode acp»). */
  readonly name: string;
  open(spec: ParticipantSpec, signal?: AbortSignal): Promise<Participant>;
  /** Освободить общие ресурсы драйвера (loopback-сервер и т. п.). */
  dispose(): Promise<void>;
}
