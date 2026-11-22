import type { Position } from "./convergence.js";
import type { Critique, Revision, Severity } from "./protocols/consensus-schemas.js";

/**
 * Гейты совета — чистые функции, покрыты тестами.
 *
 * Consensus score (своя формула; Octopus свою не публикует):
 *   score = Σ confidence мест с ключом большинства / Σ confidence всех мест − 0.1 × незакрытые major
 *   против предложений большинства, не ниже 0. Гейт: score ≥ порога и нет вето.
 */

export const MAJOR_PENALTY = 0.1;

/** Кворум раунда: не меньше ⌊panel/2⌋ + 1 валидных ответов. Считается «ответил», а не «одобрил». */
export const quorumNeeded = (panel: number): number => Math.floor(panel / 2) + 1;

export interface OpenFlaw {
  target: string;
  critic: string;
  severity: Severity;
  veto: boolean;
  text: string;
}

/**
 * Недостатки, не закрытые доработкой: закрыт, если в доработке цели есть изменение с triggered_by
 * этого критика. Предложение, которое не дорабатывалось, ничего не закрыло.
 */
export function openFlaws(
  critiques: Map<string, Critique>,
  revisions: Map<string, Revision>,
): OpenFlaw[] {
  const out: OpenFlaw[] = [];
  for (const [critic, critique] of critiques) {
    for (const review of critique.reviews) {
      const addressed =
        revisions.get(review.label)?.changes.some((c) => c.triggered_by === critic) ?? false;
      if (addressed) continue;
      for (const flaw of review.flaws) {
        out.push({
          target: review.label,
          critic,
          severity: flaw.severity,
          veto: flaw.veto === true,
          text: flaw.text,
        });
      }
    }
  }
  return out;
}

export function consensusScore(
  positions: Position[],
  majority: string[],
  open: OpenFlaw[],
): { score: number; share: number; majors: number } {
  const total = positions.reduce((s, p) => s + p.confidence, 0);
  const weight = positions
    .filter((p) => majority.includes(p.alias))
    .reduce((s, p) => s + p.confidence, 0);
  const share = total > 0 ? weight / total : 0;
  const majors = open.filter((f) => f.severity === "major" && majority.includes(f.target)).length;
  return { score: Math.max(0, share - MAJOR_PENALTY * majors), share, majors };
}

/** Вето против решения большинства, не снятое доработкой. */
export function blockingVeto(open: OpenFlaw[], majority: string[]): OpenFlaw | undefined {
  return open.find((f) => f.veto && f.severity === "critical" && majority.includes(f.target));
}

export interface Verdict {
  alias: string;
  verdict: "pass" | "fail";
  blockers: { severity: Severity; text: string }[];
}

/** Go/no-go (review, deliver): score = доля pass; go — score ≥ порога и нет critical-блокеров. */
export function goNoGo(
  verdicts: Verdict[],
  threshold: number,
): { go: boolean; score: number; criticals: number } {
  if (verdicts.length === 0) return { go: false, score: 0, criticals: 0 };
  const passes = verdicts.filter((v) => v.verdict === "pass").length;
  const score = passes / verdicts.length;
  const criticals = verdicts
    .flatMap((v) => v.blockers)
    .filter((b) => b.severity === "critical").length;
  return { go: score >= threshold && criticals === 0, score, criticals };
}
