import { describe, expect, it } from "vitest";

import { aliasFor, shuffle } from "../src/core/anonymize.js";

describe("anonymize", () => {
  it("метки A, B, C…", () => {
    expect([0, 1, 2, 25, 26].map(aliasFor)).toEqual(["A", "B", "C", "Z", "A1"]);
  });

  it("перемешивание воспроизводится по seed и не меняет исходный массив", () => {
    const items = ["a", "b", "c", "d", "e"];
    const first = shuffle(items, "20261122-a1f3");
    expect(shuffle(items, "20261122-a1f3")).toEqual(first);
    expect([...first].sort()).toEqual(items);
    expect(items).toEqual(["a", "b", "c", "d", "e"]);
    const seeds = Array.from({ length: 20 }, (_, i) => shuffle(items, `seed-${i}`).join(""));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});
