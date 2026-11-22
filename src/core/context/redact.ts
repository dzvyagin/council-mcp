/**
 * Маскирование секретов в текстах, которые уходят в промпты, транскрипты, отчёты и ADR.
 * Эвристики консервативные: лучше лишний раз замаскировать, чем пропустить ключ.
 */

export const MASK = "***";

interface Rule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const KEY_NAMES =
  "(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|credentials?)";

const RULES: Rule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi,
    replace: (_m, prefix) => `${prefix}:${MASK}@`,
  },
  {
    name: "bearer",
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme) => `${scheme} ${MASK}`,
  },
  { name: "jwt", pattern: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, replace: () => MASK },
  {
    name: "known-token",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gh[ous]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
    replace: () => MASK,
  },
  {
    // "password": "x"  |  password = x  |  DB_PASSWORD=x  |  apiKey: 'x'
    name: "assignment",
    pattern: new RegExp(
      `((?:["']?)\\b[A-Za-z0-9_.-]*${KEY_NAMES}["']?\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;}\\]]+)`,
      "gi",
    ),
    replace: (match, head, value) => {
      // Код вида `password = readPassword()` — не секрет.
      if (value.includes("(")) return match;
      if (value === MASK || /^["']\*\*\*["']$/.test(value)) return `${head}${value}`;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${head}${quote}${MASK}${quote}`;
    },
  },
];

export interface Redaction {
  text: string;
  count: number;
}

export class Redactor {
  private readonly exact: string[];

  /** `known` — точные значения секретов (например, ключ API из env): маскируются всегда. */
  constructor(known: string[] = []) {
    this.exact = known.filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  }

  redact(text: string): Redaction {
    let count = 0;
    let out = text;
    for (const secret of this.exact) {
      const parts = out.split(secret);
      count += parts.length - 1;
      out = parts.join(MASK);
    }
    for (const rule of RULES) {
      out = out.replace(rule.pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        const groups = args.slice(1, -2) as string[];
        const replaced = rule.replace(match, ...groups);
        if (replaced !== match) count++;
        return replaced;
      });
    }
    return { text: out, count };
  }

  text(value: string): string {
    return this.redact(value).text;
  }

  /** Рекурсивно маскирует все строки в JSON-совместимом значении. */
  deep<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((v: unknown) => this.deep(v)) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.deep(v)])) as T;
    }
    return value;
  }
}
