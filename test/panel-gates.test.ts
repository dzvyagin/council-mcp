import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/core/config.js";
import {
  blockingVeto,
  consensusScore,
  goNoGo,
  openFlaws,
  quorumNeeded,
} from "../src/core/gates.js";
import {
  buildPanel,
  PERSONAS,
  resolvePersonas,
  seatsPerModel,
  STYLE_PERSONAS,
} from "../src/core/panel.js";
import type { Critique, Revision } from "../src/core/protocols/consensus-schemas.js";
import { critiqueRules, outputRules } from "../src/core/protocols/consensus.js";
import { baseEnv, fakeDeps } from "./helpers.js";

const config = loadConfig(fakeDeps(baseEnv));
const two = loadConfig(fakeDeps({ ...baseEnv, COUNCIL_MODELS: "m1,m2" }));

describe("панель", () => {
  it.each([
    [3, [1, 1, 1]],
    [5, [1, 2, 2]],
    [7, [2, 2, 3]],
  ] as const)("panel %i на 3 моделях — %j мест на модель", (panel, counts) => {
    const seats = buildPanel({ models: config.models, panel, style: "balanced", seed: "s" });
    expect(seats).toHaveLength(panel);
    expect([...seatsPerModel(seats).values()].sort()).toEqual(counts);
    expect(new Set(seats.map((s) => s.persona.id)).size).toBe(panel);
  });

  it("две модели, panel 3 — одна модель играет две персоны", () => {
    const seats = buildPanel({ models: two.models, panel: 3, style: "balanced", seed: "s" });
    expect([...seatsPerModel(seats).values()].sort()).toEqual([1, 2]);
  });

  it("стиль задаёт состав; раскладка воспроизводится по seed", () => {
    const red = buildPanel({ models: config.models, panel: 3, style: "red-team", seed: "s" });
    expect(red.map((s) => s.persona.id)).toEqual(["architect", "attacker", "insider"]);
    expect(
      buildPanel({ models: config.models, panel: 3, style: "adversarial", seed: "s" }).map(
        (s) => s.persona.id,
      ),
    ).toContain("devil");
    expect(
      buildPanel({ models: config.models, panel: 3, style: "executive", seed: "s" }).map(
        (s) => s.persona.id,
      ),
    ).toContain("analyst");
    expect(
      buildPanel({ models: config.models, panel: 3, style: "implementation", seed: "s" }).map(
        (s) => s.persona.id,
      ),
    ).toContain("lead");
    const a = buildPanel({ models: config.models, panel: 5, style: "balanced", seed: "run-1" });
    const b = buildPanel({ models: config.models, panel: 5, style: "balanced", seed: "run-1" });
    expect(a.map((s) => s.model.id)).toEqual(b.map((s) => s.model.id));
    for (const ids of Object.values(STYLE_PERSONAS)) expect(new Set(ids).size).toBe(7);
  });

  it("право вето по умолчанию — у SRE и безопасности; переопределения из конфига", () => {
    expect(
      Object.values(PERSONAS)
        .filter((p) => p.vetoPower)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["security", "sre"]);
    const custom = resolvePersonas({
      dba: { vetoPower: true, focus: "Oracle" },
      nope: { name: "x" },
    });
    expect(custom.dba).toMatchObject({
      vetoPower: true,
      focus: "Oracle",
      name: "Архитектор данных / DBA",
    });
    expect(custom.nope).toBeUndefined();
  });
});

const crit = (
  labels: string[],
  severity: "critical" | "major" | "minor",
  veto = false,
): Critique => ({
  reviews: labels.map((label) => ({
    label,
    strengths: [],
    flaws: [{ text: `f ${label}`, severity, ...(veto && { veto }) }],
    questions: [],
  })),
  ranking: labels,
});
const rev = (key: string, triggeredBy: string[] = []): Revision => ({
  decision_key: key,
  summary: "s",
  design: "d",
  alternatives: [],
  risks: [],
  assumptions: [],
  open_questions: [],
  confidence: 0.8,
  changes: triggeredBy.map((t) => ({ what: "w", why: "y", triggered_by: t })),
});
const pos = (alias: string, confidence: number) => ({
  alias,
  modelId: alias,
  key: alias === "C" ? "y" : "x",
  confidence,
});

describe("гейты", () => {
  it("кворум ⌊panel/2⌋ + 1", () => {
    expect([3, 5, 7].map(quorumNeeded)).toEqual([2, 3, 4]);
  });

  it("score — доля уверенности большинства минус 0.1 за незакрытый major против большинства, не ниже 0", () => {
    const positions = [pos("A", 0.9), pos("B", 0.9), pos("C", 0.6)];
    expect(consensusScore(positions, ["A", "B"], []).score).toBeCloseTo(0.75);
    const open = openFlaws(
      new Map([["C", crit(["A", "B"], "major")]]),
      new Map([
        ["A", rev("x", ["C"])],
        ["B", rev("x")],
      ]),
    );
    expect(open.map((f) => f.target)).toEqual(["B"]); // у A недостаток закрыт
    expect(consensusScore(positions, ["A", "B"], open)).toMatchObject({ majors: 1 });
    expect(consensusScore(positions, ["A", "B"], open).score).toBeCloseTo(0.65);
    const many = Array.from({ length: 12 }, () => open[0]!);
    expect(consensusScore(positions, ["A", "B"], many).score).toBe(0);
    // major против меньшинства не штрафует
    const minority = openFlaws(new Map([["A", crit(["C"], "major")]]), new Map([["C", rev("y")]]));
    expect(consensusScore(positions, ["A", "B"], minority).score).toBeCloseTo(0.75);
  });

  it("вето блокирует, только если против большинства и не снято доработкой", () => {
    const critiques = new Map([["C", crit(["A", "B"], "critical", true)]]);
    expect(
      blockingVeto(
        openFlaws(
          critiques,
          new Map([
            ["A", rev("x")],
            ["B", rev("x")],
          ]),
        ),
        ["A", "B"],
      ),
    ).toMatchObject({ critic: "C", target: "A" });
    expect(
      blockingVeto(
        openFlaws(
          critiques,
          new Map([
            ["A", rev("x", ["C"])],
            ["B", rev("x", ["C"])],
          ]),
        ),
        ["A", "B"],
      ),
    ).toBeUndefined();
    expect(
      blockingVeto(openFlaws(new Map([["A", crit(["C"], "critical", true)]]), new Map()), [
        "A",
        "B",
      ]),
    ).toBeUndefined();
  });

  it("правила критики: вето только у роли с правом вето и только для critical", () => {
    expect(critiqueRules(["A"], false)(crit(["A"], "critical", true))).toMatch(/нет права вето/);
    expect(critiqueRules(["A"], true)(crit(["A"], "major", true))).toMatch(/только для critical/);
    expect(critiqueRules(["A"], true)(crit(["A"], "critical", true))).toBeUndefined();
  });

  it("go/no-go: доля pass ≥ порога и нет critical", () => {
    const v = (verdict: "pass" | "fail", severity?: "critical" | "major") => ({
      alias: "A",
      verdict,
      blockers: severity ? [{ severity, text: "b" }] : [],
    });
    expect(goNoGo([v("pass"), v("pass"), v("pass"), v("fail", "major")], 0.75)).toMatchObject({
      go: true,
      score: 0.75,
    });
    expect(goNoGo([v("pass"), v("pass"), v("fail", "major")], 0.75).go).toBe(false);
    expect(goNoGo([v("pass", "critical"), v("pass")], 0.75)).toMatchObject({
      go: false,
      criticals: 1,
    });
    expect(goNoGo([], 0.75).go).toBe(false);
  });

  it("форма итога по goal и style", () => {
    expect(outputRules("decision", "balanced")).toMatchObject({
      needPlan: false,
      needFiles: false,
    });
    expect(outputRules("plan", "balanced")).toMatchObject({ needPlan: true, needFiles: false });
    expect(outputRules("implement", "balanced")).toMatchObject({ needPlan: true, needFiles: true });
    expect(outputRules("decision", "implementation")).toMatchObject({
      needPlan: true,
      needFiles: true,
    });
    expect(outputRules("decision", "executive").rules.join(" ")).toMatch(/руководителя/);
    expect(outputRules("advice", "balanced").rules.join(" ")).toMatch(/совет/);
  });
});
