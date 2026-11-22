import { describe, expect, it } from "vitest";

import { tallyVotes, type TallyVote } from "../src/core/protocols/vote.js";

const v = (alias: string, modelId: string, choice: string, confidence: number): TallyVote => ({
  alias,
  modelId,
  choice,
  confidence,
  rationale: "r",
});

describe("tallyVotes", () => {
  it("все за одно — converged, score 1", () => {
    const t = tallyVotes([v("A", "m1", "x", 0.9), v("B", "m2", "X ", 0.5), v("C", "m3", "x", 0.7)]);
    expect(t).toMatchObject({ status: "converged", winner: "x", score: 1, dissent: [] });
  });

  it("большинство взвешивается по уверенности, меньшинство — в особом мнении", () => {
    const t = tallyVotes([v("A", "m1", "x", 0.8), v("B", "m2", "x", 0.8), v("C", "m3", "y", 0.4)]);
    expect(t.status).toBe("majority");
    expect(t.winner).toBe("x");
    expect(t.score).toBeCloseTo(0.8);
    expect(t.dissent.map((d) => d.alias)).toEqual(["C"]);
  });

  it("все разные — tie", () => {
    const t = tallyVotes([v("A", "m1", "x", 0.9), v("B", "m2", "y", 0.3), v("C", "m3", "z", 0.2)]);
    expect(t.status).toBe("tie");
    expect(t.winner).toBeUndefined();
  });

  it("большинство из одной модели не засчитывается", () => {
    const t = tallyVotes([v("A", "m1", "x", 0.9), v("B", "m1", "x", 0.9), v("C", "m2", "y", 0.5)]);
    expect(t.status).toBe("tie");
  });

  it("одиночный голос с большим весом не побеждает двух согласных", () => {
    const t = tallyVotes([v("A", "m1", "x", 0.3), v("B", "m2", "x", 0.3), v("C", "m3", "y", 0.9)]);
    expect(t.status).toBe("tie");
  });

  it("равный вес у двух групп — tie", () => {
    const t = tallyVotes([
      v("A", "m1", "x", 0.5),
      v("B", "m2", "x", 0.5),
      v("C", "m1", "y", 0.5),
      v("D", "m2", "y", 0.5),
    ]);
    expect(t.status).toBe("tie");
  });

  it("две модели — majority возможно", () => {
    const t = tallyVotes([v("A", "m1", "x", 0.8), v("B", "m2", "x", 0.6)]);
    expect(t).toMatchObject({ status: "converged", winner: "x" });
  });

  it("одна модель — partial, нет голосов — failed", () => {
    expect(tallyVotes([v("A", "m1", "x", 0.8)]).status).toBe("partial");
    expect(tallyVotes([]).status).toBe("failed");
  });
});
