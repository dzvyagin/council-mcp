/** Маркеры участников по порядку меток A, B, C… */
const MARKERS = ["🟥", "🟨", "🟦", "🟩", "🟪", "🟧", "🟫"];

export function markerFor(alias: string): string {
  const index = alias.charCodeAt(0) - "A".charCodeAt(0);
  return MARKERS[index % MARKERS.length] ?? "⬜";
}

/** 65_000 → «1 мин 05 с», 4_000 → «4 с». */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} с`;
  return `${minutes} мин ${String(seconds).padStart(2, "0")} с`;
}

/** 182_400 → «182k», 950 → «950». */
export function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
}
