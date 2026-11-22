import { describe, expect, it } from "vitest";

import { Redactor } from "../src/core/context/redact.js";

const r = new Redactor(["exact-secret-value-123"]);

describe("Redactor", () => {
  it.each([
    ["DB_PASSWORD=hunter2", "DB_PASSWORD=***"],
    ['{"password": "p@ss w0rd"}', '{"password": "***"}'],
    ["api_key: 'abc123xyz'", "api_key: '***'"],
    ["client_secret = s3cr3t; next", "client_secret = ***; next"],
    ["Authorization: Bearer abcdefghijklmnop", "Authorization: Bearer ***"],
    ["postgres://app:Sup3rS3cret@db:5432/pay", "postgres://app:***@db:5432/pay"],
    ["key sk-proj-abcdefghijklmnopqrstuv end", "key *** end"],
    ["AKIAABCDEFGHIJKLMNOP", "***"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "***"],
    ["jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4", "jwt ***"],
    ["use exact-secret-value-123 here", "use *** here"],
  ])("%s", (input, expected) => {
    expect(r.text(input)).toBe(expected);
  });

  it("закрытые ключи PEM", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(r.text(`x\n${pem}\ny`)).toBe(
      "x\n-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----\ny",
    );
  });

  it("не трогает обычный текст и код", () => {
    const code =
      "const passwordPolicy = loadPolicy();\nСм. db/schema.sql:10 — индекс по created_at";
    expect(r.text("Партиционировать по created_at, PostgreSQL 16")).toBe(
      "Партиционировать по created_at, PostgreSQL 16",
    );
    expect(r.redact("token budget 1000 tokens").count).toBe(0);
    expect(r.text(code)).toBe(code);
  });

  it("считает замены и маскирует вложенные структуры", () => {
    expect(r.redact("password=a token=b").count).toBe(2);
    expect(r.deep({ a: ["password=x", 1], b: { c: "Bearer abcdefghij" } })).toEqual({
      a: ["password=***", 1],
      b: { c: "Bearer ***" },
    });
  });

  it("повторное маскирование ничего не меняет", () => {
    const once = r.text('password="x" url=https://u:p@h/');
    expect(r.text(once)).toBe(once);
  });
});
