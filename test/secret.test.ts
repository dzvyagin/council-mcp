import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { Secret } from "../src/core/secret.js";

describe("Secret", () => {
  it("маскируется при любом выводе и раскрывается только явно", () => {
    const s = new Secret("sk-very-secret");
    expect(String(s)).toBe("***");
    expect(JSON.stringify({ s })).toBe('{"s":"***"}');
    expect(inspect({ s })).not.toContain("sk-very-secret");
    expect(s.reveal()).toBe("sk-very-secret");
  });
});
