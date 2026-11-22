import type { CouncilConfig } from "../../core/config.js";
import type { Participant, ParticipantDriver, ParticipantSpec } from "../../core/participant.js";
import { AnswerServer } from "./answer-server.js";
import { AcpParticipant } from "./participant.js";
import { resolveProfile, type AgentProfile } from "./profiles.js";

export interface AcpDriverOptions {
  profile?: AgentProfile;
  log?: (message: string) => void;
  settleMs?: number;
  startupMs?: number;
}

/** Драйвер участников поверх ACP: один процесс агента на место, общий loopback MCP для ответов. */
export class AcpDriver implements ParticipantDriver {
  readonly name: string;
  private readonly profile: AgentProfile;
  private answers: Promise<AnswerServer> | undefined;

  constructor(
    private readonly config: CouncilConfig,
    private readonly options: AcpDriverOptions = {},
  ) {
    this.profile = options.profile ?? resolveProfile(config);
    this.name = this.profile.label;
  }

  async open(spec: ParticipantSpec, signal?: AbortSignal): Promise<Participant> {
    this.answers ??= AnswerServer.start();
    const answers = await this.answers;
    const launch = await this.profile.launch(spec.model, this.config);
    return AcpParticipant.open(
      {
        spec,
        launch,
        workspace: this.config.workspace,
        answers,
        ...(this.options.log && { log: this.options.log }),
        ...(this.options.settleMs !== undefined && { settleMs: this.options.settleMs }),
        ...(this.options.startupMs !== undefined && { startupMs: this.options.startupMs }),
      },
      signal,
    );
  }

  async dispose(): Promise<void> {
    const answers = this.answers;
    this.answers = undefined;
    if (answers) await (await answers).close();
  }
}
