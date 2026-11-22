import { aliasFor, shuffle } from "./anonymize.js";
import type { ModelConfig } from "./config.js";
import type { Persona, SeatSpec } from "./panel.js";
import type { EventSink } from "./events.js";
import { createLimiter } from "./limit.js";
import {
  addUsage,
  emptyUsage,
  type AnswerTool,
  type AskRequest,
  type Participant,
  type ParticipantDriver,
  type Usage,
} from "./participant.js";
import { promptHash, type TranscriptEntry } from "./output/transcript.js";
import type { ParticipantSummary, SeatAssignment, SeatState } from "./types.js";

/**
 * Раннер раундов: открывает участников, раздаёт метки по seed, задаёт вопросы параллельно
 * (с лимитом на модель), делает один повтор при сбое и отмечает деградацию.
 */

export interface Seat {
  alias: string;
  model: ModelConfig;
  persona: Persona;
  state: SeatState;
  note?: string;
  participant?: Participant;
  usage: Usage;
}

export interface CouncilSessionOptions {
  driver: ParticipantDriver;
  /** Места панели (персона + модель) в порядке персон; метки раздаются перемешиванием по seed. */
  seats: SeatSpec[];
  tools: AnswerTool[];
  /** Seed перемешивания — run_id: повторный прогон даёт то же распределение меток. */
  seed: string;
  roundTimeoutS: number;
  emit: EventSink;
  signal: AbortSignal;
  /** Сколько повторов на участника в раунде (по умолчанию 1). */
  retries?: number;
  /** Запись в транскрипт: каждая попытка ответа. */
  record?: (entry: TranscriptEntry) => void;
  /** Бюджет запуска: протоколы проверяют его между раундами (overBudget). */
  budget?: {
    maxCalls?: number | undefined;
    maxTokens?: number | undefined;
    maxDurationS?: number | undefined;
  };
  now?: () => number;
}

export type RoundAnswers<T> = Map<string, T>;

export class CouncilSession {
  readonly seats: Seat[];
  private readonly limiters = new Map<string, <R>(task: () => Promise<R>) => Promise<R>>();
  private readonly retries: number;

  private readonly startedAt: number;

  constructor(private readonly options: CouncilSessionOptions) {
    this.retries = options.retries ?? 1;
    this.startedAt = (options.now ?? Date.now)();
    this.seats = shuffle(options.seats, options.seed).map((spec, i) => ({
      alias: aliasFor(i),
      model: spec.model,
      persona: spec.persona,
      state: "ok",
      usage: emptyUsage(),
    }));
    for (const s of options.seats) {
      if (!this.limiters.has(s.model.id))
        this.limiters.set(s.model.id, createLimiter(s.model.maxConcurrency));
    }
  }

  get assignments(): SeatAssignment[] {
    return this.seats.map((s) => ({ alias: s.alias, modelId: s.model.id, persona: s.persona.id }));
  }

  seat(alias: string): Seat | undefined {
    return this.seats.find((s) => s.alias === alias);
  }

  get activeSeats(): Seat[] {
    return this.seats.filter((s) => s.state !== "failed");
  }

  /** Число разных моделей среди работающих мест. */
  get activeModels(): number {
    return new Set(this.activeSeats.map((s) => s.model.id)).size;
  }

  /**
   * Бюджет исчерпан? Проверяется между раундами: текущий раунд дожидается, новые не начинаются,
   * итог синтезируется из имеющегося со статусом partial.
   */
  overBudget(): string | undefined {
    const b = this.options.budget;
    if (!b) return undefined;
    const u = this.usage;
    if (b.maxCalls !== undefined && u.calls >= b.maxCalls)
      return `вызовов ${String(u.calls)} из ${String(b.maxCalls)}`;
    const tokens = u.inputTokens + u.outputTokens;
    if (b.maxTokens !== undefined && tokens >= b.maxTokens)
      return `токенов ${String(tokens)} из ${String(b.maxTokens)}`;
    const elapsed = ((this.options.now ?? Date.now)() - this.startedAt) / 1000;
    if (b.maxDurationS !== undefined && elapsed >= b.maxDurationS) {
      return `время ${String(Math.round(elapsed))} с из ${String(b.maxDurationS)} с`;
    }
    return undefined;
  }

  get usage(): Usage {
    return this.seats.reduce((acc, s) => addUsage(acc, s.usage), emptyUsage());
  }

  summaries(): ParticipantSummary[] {
    return this.seats.map((s) => ({
      alias: s.alias,
      personas: [s.persona.short],
      state: s.state,
      ...(s.note !== undefined && { note: s.note }),
    }));
  }

  /** Задаёт вопрос работающим местам (или подмножеству); возвращает валидные ответы по меткам. */
  async askAll<T>(
    round: string,
    build: (seat: Seat) => Omit<AskRequest<T>, "round" | "timeoutS" | "signal">,
    only?: (seat: Seat) => boolean,
  ): Promise<RoundAnswers<T>> {
    const seats = this.activeSeats.filter((s) => only?.(s) ?? true);
    this.options.emit({ type: "round_started", round, aliases: seats.map((s) => s.alias) });
    const answers: RoundAnswers<T> = new Map();
    await Promise.all(
      seats.map((seat) =>
        this.limiterFor(seat)(async () => {
          const value = await this.askSeat(round, seat, build(seat));
          if (value !== undefined) answers.set(seat.alias, value.value);
        }),
      ),
    );
    this.options.emit({ type: "round_finished", round });
    return answers;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.seats.flatMap((s) => (s.participant ? [s.participant.close()] : [])),
    );
    for (const s of this.seats) delete s.participant;
  }

  private limiterFor(seat: Seat) {
    const limiter = this.limiters.get(seat.model.id);
    if (!limiter) throw new Error(`нет лимитера для модели места ${seat.alias}`);
    return limiter;
  }

  private async ensureParticipant(seat: Seat): Promise<Participant> {
    if (seat.participant) return seat.participant;
    seat.participant = await this.options.driver.open(
      { alias: seat.alias, model: seat.model, tools: this.options.tools },
      this.options.signal,
    );
    return seat.participant;
  }

  private async askSeat<T>(
    round: string,
    seat: Seat,
    request: Omit<AskRequest<T>, "round" | "timeoutS" | "signal">,
  ): Promise<{ value: T } | undefined> {
    const { emit, signal } = this.options;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return undefined;
      let reason: string;
      try {
        const participant = await this.ensureParticipant(seat);
        const result = await participant.ask({
          ...request,
          round,
          timeoutS: this.options.roundTimeoutS,
          signal,
        });
        seat.usage = addUsage(seat.usage, result.usage);
        this.options.record?.({
          type: "ask",
          round,
          alias: seat.alias,
          model: seat.model.id,
          ...(request.role !== undefined && { role: request.role }),
          attempt,
          prompt_hash: promptHash(request.prompt),
          usage: result.usage,
          duration_ms: result.durationMs,
          raw: result.transcript,
          ...(result.ok
            ? { parsed: result.value }
            : { error: { kind: result.error.kind, message: result.error.message } }),
        });
        if (result.ok) {
          emit({
            type: "participant_done",
            round,
            alias: seat.alias,
            durationMs: result.durationMs,
          });
          return { value: result.value };
        }
        if (result.error.kind === "cancelled" || isAborted(signal)) return undefined;
        reason = result.error.kind;
        if (result.error.kind === "agent_exited") await this.dropParticipant(seat);
      } catch (error) {
        // Участник не запустился или упал вне хода.
        reason = error instanceof Error ? error.message : String(error);
        this.options.record?.({
          type: "ask",
          round,
          alias: seat.alias,
          model: seat.model.id,
          attempt,
          error: { kind: "agent_error", message: reason },
        });
        await this.dropParticipant(seat);
      }

      if (attempt >= this.retries) {
        seat.state = "failed";
        seat.note = reason;
        await this.dropParticipant(seat);
        emit({ type: "participant_failed", round, alias: seat.alias, reason });
        return undefined;
      }
      seat.state = "degraded";
      seat.note = `${attempt + 1} ретрай: ${reason}`;
      emit({ type: "participant_retry", round, alias: seat.alias, reason });
    }
  }

  private async dropParticipant(seat: Seat): Promise<void> {
    const p = seat.participant;
    delete seat.participant;
    await p?.close().catch(() => undefined);
  }
}

/** Сигнал может сработать во время await — читаем его заново, а не по сузившемуся типу. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
