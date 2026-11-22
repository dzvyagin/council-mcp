/** События хода обсуждения. Адаптеры (CLI, MCP) сами решают, куда их выводить. */
export type CouncilEvent =
  | { type: "run_started"; runId: string; mode: string; aliases: string[] }
  | { type: "round_started"; round: string; aliases: string[] }
  | { type: "participant_done"; round: string; alias: string; durationMs: number }
  | { type: "participant_activity"; round: string; alias: string; title: string }
  | { type: "participant_retry"; round: string; alias: string; reason: string }
  | { type: "participant_failed"; round: string; alias: string; reason: string }
  | { type: "round_finished"; round: string }
  | { type: "run_finished"; status: string };

export type EventSink = (event: CouncilEvent) => void;

export const noopSink: EventSink = () => undefined;
