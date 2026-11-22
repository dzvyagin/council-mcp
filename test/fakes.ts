import {
  emptyUsage,
  ParticipantError,
  type AskRequest,
  type AskResult,
  type Participant,
  type ParticipantDriver,
  type ParticipantErrorKind,
  type ParticipantSpec,
} from "../src/core/participant.js";

/** Ответ фейка: значение (валидируется схемой инструмента) или ошибка. */
export type FakeReply = { value: unknown } | { error: ParticipantErrorKind } | { throws: string };

export interface FakeScript {
  /** modelId → раунд → очередь ответов (по одному на попытку). */
  [modelId: string]: Record<string, FakeReply[]>;
}

export class FakeDriver implements ParticipantDriver {
  readonly name = "fake";
  readonly prompts: { modelId: string; alias: string; round: string; prompt: string }[] = [];
  opened = 0;
  closed = 0;

  constructor(
    private readonly script: FakeScript,
    private readonly failOpen: Set<string> = new Set(),
  ) {}

  open(spec: ParticipantSpec): Promise<Participant> {
    if (this.failOpen.has(spec.model.id))
      return Promise.reject(new Error("не удалось запустить агента"));
    this.opened++;
    const prompts = this.prompts;
    const script = this.script;
    const onClose = () => {
      this.closed++;
    };
    const participant: Participant = {
      alias: spec.alias,
      ask<T>(req: AskRequest<T>): Promise<AskResult<T>> {
        prompts.push({
          modelId: spec.model.id,
          alias: spec.alias,
          round: req.round,
          prompt: req.prompt,
        });
        const queue = script[spec.model.id]?.[req.round] ?? [];
        const reply = queue.shift() ?? { error: "no_answer" };
        const usage = { ...emptyUsage(), calls: 1, inputTokens: 100, outputTokens: 20 };
        if ("throws" in reply) return Promise.reject(new Error(reply.throws));
        if ("error" in reply) {
          return Promise.resolve({
            ok: false,
            error: new ParticipantError(reply.error, reply.error),
            usage,
            transcript: "",
            durationMs: 5,
          });
        }
        const parsed = req.tool.schema.safeParse(reply.value);
        if (!parsed.success)
          throw new Error(`фейк: невалидный ответ ${JSON.stringify(reply.value)}`);
        return Promise.resolve({
          ok: true,
          value: parsed.data,
          usage,
          transcript: "",
          durationMs: 5,
        });
      },
      close() {
        onClose();
        return Promise.resolve();
      },
    };
    return Promise.resolve(participant);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export const vote = (choice: string, confidence: number, rationale = "потому что"): FakeReply => ({
  value: { choice, confidence, rationale },
});
