import type { CouncilEvent } from "../events.js";
import { formatDuration, markerFor } from "./format.js";

type SeatState =
  | { kind: "waiting" }
  | { kind: "running"; since: number }
  | { kind: "done"; durationMs: number }
  | { kind: "retry"; reason: string; since: number }
  | { kind: "failed"; reason: string };

/**
 * Снимок хода запуска: собирает события и рендерит короткий текст с маркерами участников.
 * Нужен потому, что opencode не показывает MCP progress notifications, а DSH обрывает
 * вызов через 60 с: прогресс уходит хосту в каждом промежуточном ответе.
 */
export class ProgressTracker {
  private runId = "";
  private mode = "";
  private startedAt: number;
  private round: string | undefined;
  private status: string | undefined;
  private readonly seats = new Map<string, SeatState>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  apply(event: CouncilEvent): void {
    const t = this.now();
    switch (event.type) {
      case "run_started":
        this.runId = event.runId;
        this.mode = event.mode;
        this.startedAt = t;
        for (const alias of event.aliases) this.seats.set(alias, { kind: "waiting" });
        break;
      case "round_started":
        this.round = event.round;
        for (const alias of event.aliases) this.seats.set(alias, { kind: "running", since: t });
        break;
      case "participant_done":
        this.seats.set(event.alias, { kind: "done", durationMs: event.durationMs });
        break;
      case "participant_retry":
        this.seats.set(event.alias, { kind: "retry", reason: event.reason, since: t });
        break;
      case "participant_failed":
        this.seats.set(event.alias, { kind: "failed", reason: event.reason });
        break;
      case "round_finished":
        break;
      case "run_finished":
        this.status = event.status;
        break;
    }
  }

  render(): string {
    const t = this.now();
    const head = [
      `🏛 Council · ${this.mode} · участников ${this.seats.size}`,
      `run ${this.runId}`,
      formatDuration(t - this.startedAt),
    ].join(" · ");
    const seats = [...this.seats.entries()]
      .map(([alias, s]) => `${markerFor(alias)} ${alias} ${describeSeat(s, t)}`)
      .join("   ");
    const lines = [head];
    if (this.round !== undefined) lines.push(`Раунд: ${this.round}`);
    lines.push(seats);
    if (this.status !== undefined) lines.push(`Статус: ${this.status}`);
    return lines.join("\n");
  }
}

function describeSeat(s: SeatState, t: number): string {
  switch (s.kind) {
    case "waiting":
      return "·";
    case "running":
      return `… ${formatDuration(t - s.since)}`;
    case "done":
      return `✓ ${formatDuration(s.durationMs)}`;
    case "retry":
      return `⚠ ретрай (${s.reason})`;
    case "failed":
      return `✗ ${s.reason}`;
  }
}
