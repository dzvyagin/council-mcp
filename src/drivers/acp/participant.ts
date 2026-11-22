import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  Readable,
  Writable,
  type Readable as NodeReadable,
  type Writable as NodeWritable,
} from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import {
  emptyUsage,
  ParticipantError,
  type AskRequest,
  type AskResult,
  type Participant,
  type ParticipantSpec,
  type Usage,
} from "../../core/participant.js";
import { reminderPrompt } from "../../core/prompts/common.js";
import type { AnswerServer } from "./answer-server.js";
import { ANSWER_SERVER, type LaunchSpec } from "./profiles.js";

/**
 * Участник совета = один процесс ACP-агента и одна сессия в нём на весь запуск.
 * Раунд завершается первым валидным вызовом инструмента ответа, а не концом хода:
 * субагенты opencode работают в фоне и могут пережить ход.
 */

type Child = ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;

export interface AcpParticipantOptions {
  spec: ParticipantSpec;
  launch: LaunchSpec;
  workspace: string;
  answers: AnswerServer;
  /** Сколько ждать завершения хода после принятого ответа, прежде чем отменить его. */
  settleMs?: number;
  /** Сколько ждать запуска агента и создания сессии. */
  startupMs?: number;
  log?: (message: string) => void;
}

const STDERR_TAIL = 4_000;

export class AcpParticipant implements Participant {
  readonly alias: string;
  private transcript = "";
  private onActivity: ((title: string) => void) | undefined;
  private stderrTail = "";
  private exited: string | undefined;
  private closed = false;
  private exitedPromise: Promise<void> = new Promise(() => undefined);

  private constructor(
    private readonly options: AcpParticipantOptions,
    private readonly child: Child,
    private readonly connection: acp.ClientConnection,
    private readonly session: acp.ActiveSession,
    private readonly token: string,
  ) {
    this.alias = options.spec.alias;
  }

  static async open(options: AcpParticipantOptions, signal?: AbortSignal): Promise<AcpParticipant> {
    const { launch, workspace, answers, spec } = options;
    const log = options.log ?? (() => undefined);
    const registration = answers.register(spec.tools);
    const child = spawn(launch.command, launch.args, {
      cwd: workspace,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    const exited = new Promise<string>((resolve) => {
      child.once("error", (e) => {
        resolve(`не удалось запустить «${launch.command}»: ${e.message}`);
      });
      child.once("exit", (code, sig) => {
        resolve(`агент завершился (${sig ?? `код ${String(code)}`})`);
      });
    });

    const connection = acp
      .client({ name: "council-mcp" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        // Второй рубеж read-only: всё, о чём агент спрашивает, отклоняется.
        const reject = ctx.params.options.find((o) => o.kind.startsWith("reject"));
        log(`${spec.alias}: отклонён запрос прав «${ctx.params.toolCall.title ?? "?"}»`);
        return reject
          ? { outcome: { outcome: "selected", optionId: reject.optionId } }
          : { outcome: { outcome: "cancelled" } };
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      );

    const fail = async (message: string): Promise<never> => {
      connection.close();
      child.kill("SIGKILL");
      answers.unregister(registration.token);
      await launch.cleanup();
      const tail = stderrTail.trim()
        ? `\n${stderrTail.trim().split("\n").slice(-5).join("\n")}`
        : "";
      throw new ParticipantError("agent_error", `${message}${tail}`);
    };

    try {
      const start = (async () => {
        const init = await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        if (init.agentCapabilities?.mcpCapabilities?.http !== true) {
          throw new ParticipantError(
            "unsupported",
            "агент не поддерживает MCP по HTTP — нечем сдавать ответы совета",
          );
        }
        const session = await connection.agent
          .buildSession({
            cwd: workspace,
            mcpServers: [{ type: "http", name: ANSWER_SERVER, ...registration.endpoint }],
          })
          .start();
        for (const option of launch.configOptions) {
          await connection.agent
            .request(acp.methods.agent.session.setConfigOption, {
              sessionId: session.sessionId,
              configId: option.configId,
              value: option.value,
            })
            .catch(() => undefined); // агент может не поддерживать опцию — модель задана через env
        }
        return session;
      })();
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("агент не ответил при запуске"));
        }, options.startupMs ?? 60_000).unref();
      });
      const aborted = new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new Error("запуск отменён"));
        });
      });
      const session = await Promise.race([
        start,
        timeout,
        aborted,
        exited.then((reason) => Promise.reject(new Error(reason))),
      ]);
      const participant = new AcpParticipant(
        options,
        child,
        connection,
        session,
        registration.token,
      );
      participant.stderrTail = stderrTail;
      child.stderr.on("data", (chunk: string) => {
        participant.stderrTail = (participant.stderrTail + chunk).slice(-STDERR_TAIL);
      });
      participant.exitedPromise = exited.then((reason) => {
        participant.exited ??= reason;
      });
      return participant;
    } catch (error) {
      if (error instanceof ParticipantError && error.kind === "unsupported") {
        await fail(error.message).catch(() => undefined);
        throw error;
      }
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  async ask<T>(request: AskRequest<T>): Promise<AskResult<T>> {
    const started = Date.now();
    const usage: Usage = emptyUsage();
    this.transcript = "";
    this.onActivity = request.onActivity;
    const finish = (
      r: { ok: true; value: T } | { ok: false; error: ParticipantError },
    ): AskResult<T> => ({
      ...r,
      usage,
      transcript: this.transcript,
      durationMs: Date.now() - started,
    });

    if (this.exited !== undefined || this.closed) {
      return finish({
        ok: false,
        error: new ParticipantError("agent_exited", this.exited ?? "участник закрыт"),
      });
    }

    const validate = request.validate;
    const expectation = this.options.answers.expect(
      this.token,
      request.tool.name,
      validate &&
        ((args) => {
          const parsed = request.tool.schema.safeParse(args);
          return parsed.success ? validate(parsed.data) : undefined;
        }),
    );
    const deadline = AbortSignal.timeout(request.timeoutS * 1000);
    const stops = request.signal ? [deadline, request.signal] : [deadline];

    try {
      for (const prompt of [request.prompt, reminderPrompt(request.tool.name)]) {
        const outcome = await this.turn(prompt, expectation.promise, stops, usage);
        if (outcome.kind === "answer") {
          const parsed = request.tool.schema.safeParse(outcome.value);
          if (parsed.success) return finish({ ok: true, value: parsed.data });
          return finish({
            ok: false,
            error: new ParticipantError("agent_error", "ответ не прошёл схему"),
          });
        }
        if (outcome.kind === "error") {
          const error =
            outcome.error.kind === "cancelled" && deadline.aborted && !request.signal?.aborted
              ? new ParticipantError("timeout", `истёк таймаут раунда (${request.timeoutS} с)`)
              : outcome.error;
          return finish({ ok: false, error });
        }
        // ход закончился без ответа — одно напоминание
      }
      return finish({
        ok: false,
        error: new ParticipantError("no_answer", `не вызван инструмент ${request.tool.name}`),
      });
    } finally {
      expectation.cancel();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.answers.unregister(this.token);
    this.session.dispose();
    this.connection.close();
    this.child.stdin.end();
    const gone = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else
        this.child.once("exit", () => {
          resolve();
        });
    });
    const term = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await gone;
    clearTimeout(term);
    clearTimeout(kill);
    await this.options.launch.cleanup().catch(() => undefined);
  }

  /** Один prompt-ход: ждём ответ инструмента, конец хода, падение агента или стоп-сигнал. */
  private async turn(
    prompt: string,
    answer: Promise<unknown>,
    stops: AbortSignal[],
    usage: Usage,
  ): Promise<
    | { kind: "answer"; value: unknown }
    | { kind: "ended" }
    | { kind: "error"; error: ParticipantError }
  > {
    usage.calls++;
    const response = this.session.prompt(prompt);
    void this.pumpUpdates();
    const stop = AbortSignal.any(stops);

    const winner = await Promise.race([
      answer.then((value) => ({ kind: "answer" as const, value })),
      response.then(
        (r) => ({ kind: "ended" as const, response: r }),
        (e: unknown) => ({ kind: "failed" as const, error: e }),
      ),
      onAbort(stop).then(() => ({ kind: "stop" as const })),
      this.exitedPromise.then(() => ({ kind: "exit" as const })),
    ]);

    switch (winner.kind) {
      case "answer":
        // Даём агенту закончить ход; иначе отменяем, чтобы сессия была свободна для следующего раунда.
        await this.settle(response, this.options.settleMs ?? 15_000);
        this.addUsage(usage, await response.catch(() => undefined));
        return { kind: "answer", value: winner.value };
      case "ended": {
        this.addUsage(usage, winner.response);
        // Вызов инструмента мог прийти одновременно с концом хода.
        const late = await Promise.race([
          answer.then((value) => ({ kind: "answer" as const, value })),
          delay(200).then(() => ({ kind: "ended" as const })),
        ]);
        return late;
      }
      case "failed":
        // Ошибка хода часто приходит раньше события выхода процесса — даём ему догнать.
        await Promise.race([this.exitedPromise, delay(300)]);
        return {
          kind: "error",
          error: new ParticipantError(
            this.exited !== undefined ? "agent_exited" : "agent_error",
            this.describeError(winner.error),
          ),
        };
      case "stop":
        await this.settle(response, 0);
        return { kind: "error", error: new ParticipantError("cancelled", "ход остановлен") };
      case "exit":
        return {
          kind: "error",
          error: new ParticipantError("agent_exited", this.exited ?? "агент завершился"),
        };
    }
  }

  /** Читает обновления сессии в транскрипт до конца текущего хода. */
  private async pumpUpdates(): Promise<void> {
    try {
      for (;;) {
        const message = await this.session.nextUpdate();
        if (message.kind === "stop") return;
        const update = message.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          this.append(update.content.text);
        } else if (update.sessionUpdate === "tool_call") {
          this.append(`\n[tool] ${update.title}\n`);
          this.onActivity?.(update.title);
        }
      }
    } catch {
      // сессия закрыта или соединение упало — причину сообщит turn()
    }
  }

  private append(text: string): void {
    this.transcript = (this.transcript + text).slice(-200_000);
  }

  private async settle(response: Promise<acp.PromptResponse>, ms: number): Promise<void> {
    const done = await Promise.race([
      response.then(
        () => true,
        () => true,
      ),
      delay(ms).then(() => false),
    ]);
    if (!done) {
      await this.connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId })
        .catch(() => undefined);
      const finished = await Promise.race([
        response.then(
          () => true,
          () => true,
        ),
        delay(5_000).then(() => false),
      ]);
      if (!finished) {
        // Агент не освободил сессию даже после отмены: дальше с ним работать нельзя.
        this.exited = "агент не завершил ход после отмены";
        this.child.kill("SIGKILL");
      }
    }
  }

  /** usage в ответе — нестабильное расширение ACP; читаем, если агент его прислал. */
  private addUsage(usage: Usage, response: acp.PromptResponse | undefined): void {
    const u = (response as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined)
      ?.usage;
    if (u) {
      usage.inputTokens += u.inputTokens ?? 0;
      usage.outputTokens += u.outputTokens ?? 0;
    }
  }

  private describeError(error: unknown): string {
    const base = error instanceof Error ? error.message : String(error);
    const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
    return tail ? `${base} (${tail})` : base;
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const onAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });
