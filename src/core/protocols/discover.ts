import { buildContext, type ContextInput } from "../context/builder.js";
import type { CouncilSession, Seat } from "../engine.js";
import { quorumNeeded } from "../gates.js";
import { newNonce } from "../prompts/common.js";
import { researchPrompt, type Common } from "../prompts/consensus.js";
import type { RunStatus } from "../types.js";
import { TOOLS, type Research } from "./consensus-schemas.js";

/**
 * Discover (первая фаза Double Diamond): участники независимо разбирают задачу и варианты.
 * Инструментов записи у совета нет — файлы подбирает хост, участники читают проект сами.
 * Гейт — кворум ⌊panel/2⌋ + 1 исследований.
 */

export interface DiscoverInput extends ContextInput {
  question: string;
}

export interface DiscoverOutcome {
  status: RunStatus;
  research: Map<string, Research>;
  findings: { fact: string; source: string; by: string[] }[];
  options: { key: string; summary: string; by: string[] }[];
  constraints: string[];
  unknowns: string[];
  quorum: { needed: number; answered: number; met: boolean };
  roles: Map<string, string>;
  warnings: string[];
}

export async function runDiscover(
  session: CouncilSession,
  input: DiscoverInput,
): Promise<DiscoverOutcome> {
  const nonce = newNonce();
  const context = buildContext(input);
  const roleOf = new Map(
    session.seats.map((s) => [s.alias, `${s.persona.name} — ${s.persona.focus}`]),
  );
  const common = (seat: Seat): Common => ({
    question: input.question,
    context,
    nonce,
    role: roleOf.get(seat.alias) ?? "",
  });
  const warnings: string[] = [];

  const research = await session.askAll("discover", (seat) => ({
    role: roleOf.get(seat.alias) ?? "",
    tool: TOOLS.research,
    prompt: researchPrompt(common(seat), TOOLS.research.name),
  }));

  const needed = quorumNeeded(session.seats.length);
  const met = research.size >= needed;
  if (!met) {
    warnings.push(
      `нет кворума: исследование вернули ${String(research.size)} из ${String(session.seats.length)}, нужно ${String(needed)}`,
    );
  }
  const models = new Set([...research.keys()].map((a) => session.seat(a)?.model.id)).size;
  if (met && models < 2) warnings.push("исследование дала только одна модель");

  const findings = new Map<string, { fact: string; source: string; by: string[] }>();
  const options = new Map<string, { key: string; summary: string; by: string[] }>();
  for (const [alias, r] of research) {
    for (const f of r.findings) {
      const key = `${f.source}|${f.fact.trim().toLowerCase()}`;
      const prev = findings.get(key);
      if (prev) prev.by.push(alias);
      else findings.set(key, { ...f, by: [alias] });
    }
    for (const o of r.options) {
      const prev = options.get(o.key);
      if (prev) prev.by.push(alias);
      else options.set(o.key, { ...o, by: [alias] });
    }
  }
  const all = [...research.values()];
  const status: RunStatus =
    research.size === 0
      ? "failed"
      : !met
        ? "quorum_failed"
        : models < 2
          ? "partial"
          : research.size === session.seats.length
            ? "converged"
            : "majority";
  return {
    status,
    research,
    findings: [...findings.values()].sort((a, b) => b.by.length - a.by.length),
    options: [...options.values()].sort((a, b) => b.by.length - a.by.length),
    constraints: [...new Set(all.flatMap((r) => r.constraints))],
    unknowns: [...new Set(all.flatMap((r) => r.unknowns))],
    quorum: { needed, answered: research.size, met },
    roles: roleOf,
    warnings,
  };
}
