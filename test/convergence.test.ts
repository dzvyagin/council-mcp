import { describe, expect, it } from "vitest";

import {
  assess,
  bordaScores,
  canonicalizer,
  unresolvedCriticals,
  validateGrouping,
  type Position,
} from "../src/core/convergence.js";
import type { Critique, Revision } from "../src/core/protocols/consensus-schemas.js";
import { critiqueRules, revisionRules } from "../src/core/protocols/consensus.js";

const pos = (alias: string, modelId: string, key: string, confidence = 0.8): Position => ({
  alias,
  modelId,
  key,
  confidence,
});
const id = (k: string) => k;

const review = (label: string, severity: "critical" | "major" | "minor" = "minor") => ({
  label,
  strengths: [],
  flaws: [{ text: `flaw ${label}`, severity }],
  questions: [],
});
const crit = (ranking: string[], severity?: "critical" | "major" | "minor"): Critique => ({
  reviews: ranking.map((l) => review(l, severity)),
  ranking,
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

describe("assess", () => {
  it("converged — одна группа и ≥ 2 моделей", () => {
    const r = assess([pos("A", "m1", "x"), pos("B", "m2", "x"), pos("C", "m3", "x")], id, [], 0.7);
    expect(r).toMatchObject({ status: "converged", key: "x", score: 1 });
  });

  it("majority — 2 из 3, уверенность ≥ порога", () => {
    const r = assess(
      [pos("A", "m1", "x", 0.9), pos("B", "m2", "x", 0.8), pos("C", "m3", "y", 0.6)],
      id,
      [],
      0.7,
    );
    expect(r).toMatchObject({ status: "majority", key: "x", aliases: ["A", "B"] });
    expect(r.score).toBeCloseTo(1.7 / 2.3);
  });

  it("уверенность большинства ниже порога — нет сходимости", () => {
    const r = assess(
      [pos("A", "m1", "x", 0.6), pos("B", "m2", "x", 0.7), pos("C", "m3", "y")],
      id,
      [],
      0.7,
    );
    expect(r).toMatchObject({ status: "none" });
  });

  it("незакрытый critical против большинства блокирует, против меньшинства — нет", () => {
    const positions = [pos("A", "m1", "x"), pos("B", "m2", "x"), pos("C", "m3", "y")];
    expect(assess(positions, id, [{ target: "A", critic: "C", text: "t" }], 0.7).status).toBe(
      "none",
    );
    expect(assess(positions, id, [{ target: "C", critic: "A", text: "t" }], 0.7).status).toBe(
      "majority",
    );
  });

  it("все разные, поровну и большинство одной модели — нет сходимости", () => {
    expect(
      assess([pos("A", "m1", "x"), pos("B", "m2", "y"), pos("C", "m3", "z")], id, [], 0.7).status,
    ).toBe("none");
    expect(
      assess(
        [pos("A", "m1", "x"), pos("B", "m2", "x"), pos("C", "m1", "y"), pos("D", "m2", "y")],
        id,
        [],
        0.7,
      ).status,
    ).toBe("none");
    expect(
      assess([pos("A", "m1", "x"), pos("B", "m1", "x"), pos("C", "m2", "y")], id, [], 0.7).status,
    ).toBe("none");
    expect(assess([pos("A", "m1", "x"), pos("B", "m1", "x")], id, [], 0.7).status).toBe("none");
  });

  it("группировка судьи объединяет синонимы", () => {
    const canonical = canonicalizer({
      groups: [["partition-by-month", "pg-partition-month"], ["shard"]],
      reason: "",
    });
    const r = assess(
      [
        pos("A", "m1", "pg-partition-month"),
        pos("B", "m2", "partition-by-month"),
        pos("C", "m3", "shard"),
      ],
      canonical,
      [],
      0.7,
    );
    expect(r).toMatchObject({ status: "majority", key: "partition-by-month" });
  });

  it("две модели: обе за одно — converged", () => {
    expect(assess([pos("A", "m1", "x"), pos("B", "m2", "x")], id, [], 0.7).status).toBe(
      "converged",
    );
  });
});

describe("bordaScores", () => {
  it("лучший — 1, худший — 0, усреднение по критикам", () => {
    const scores = bordaScores(
      new Map([
        ["A", crit(["B", "C"])],
        ["B", crit(["A", "C"])],
        ["C", crit(["A", "B"])],
      ]),
    );
    expect(Object.fromEntries(scores)).toEqual({ A: 1, B: 0.5, C: 0 });
  });
});

describe("unresolvedCriticals", () => {
  it("critical закрыт, если в доработке есть изменение от этого критика", () => {
    const critiques = new Map([
      ["A", crit(["B", "C"], "critical")],
      ["B", crit(["A", "C"], "minor")],
    ]);
    const revisions = new Map([
      ["B", rev("x", ["A"])],
      ["C", rev("y")],
    ]);
    expect(unresolvedCriticals(critiques, revisions)).toEqual([
      { target: "C", critic: "A", text: "flaw C" },
    ]);
  });
});

describe("правила раундов", () => {
  it("критика — ровно по чужим меткам, рейтинг — перестановка", () => {
    const rule = critiqueRules(["B", "C"]);
    expect(rule(crit(["C", "B"]))).toBeUndefined();
    expect(rule(crit(["B"]))).toMatch(/reviews/);
    expect(rule({ ...crit(["B", "C"]), ranking: ["B", "B"] })).toMatch(/ranking/);
    expect(rule(crit(["A", "B", "C"]))).toMatch(/reviews/);
  });

  it("смена ключа — только с triggered_by существующего критика", () => {
    const rule = revisionRules("x", ["B", "C"]);
    expect(rule(rev("x"))).toBeUndefined();
    expect(rule(rev("y"))).toMatch(/без changes/);
    expect(rule(rev("y", ["B"]))).toBeUndefined();
    expect(rule(rev("y", ["Z"]))).toMatch(/triggered_by/);
  });

  it("группировка — каждый ключ ровно в одной группе", () => {
    expect(validateGrouping(["a", "b"], { groups: [["a"], ["b"]], reason: "" })).toBeUndefined();
    expect(validateGrouping(["a", "b"], { groups: [["a"]], reason: "" })).toMatch(
      /не распределены/,
    );
    expect(validateGrouping(["a"], { groups: [["a"], ["a"]], reason: "" })).toMatch(/нескольких/);
    expect(validateGrouping(["a"], { groups: [["a", "z"]], reason: "" })).toMatch(/лишние/);
  });
});
