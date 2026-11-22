import { createServer, type Server } from "node:http";

/**
 * Скриптовый OpenAI-совместимый провайдер для e2e с настоящим opencode.
 *
 * Участник (в инструментах есть council_submit_*) в каждом раунде: пробует прочитать .env,
 * поручает субагенту изучить README, читает README сам и сдаёт ответ раунда.
 * Субагент (инструментов ответа нет) читает README и отвечает текстом.
 */

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

export interface ChatRequest {
  model: string;
  tools?: { function: { name: string; parameters?: unknown } }[];
  messages: ChatMessage[];
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: { text?: string }) => p.text ?? "").join("")
      : "";

const KEY = "pg-partition-by-month";

const proposal = {
  decision_key: KEY,
  summary: "Партиционировать платежи по месяцам",
  design: "Декларативное партиционирование по created_at, см. README.md:2",
  alternatives: [
    { key: "shard-by-tenant", summary: "Шардирование", why_not: "избыточно для объёма" },
  ],
  risks: [{ risk: "горячая партиция", severity: "minor", mitigation: "мониторинг" }],
  assumptions: ["PostgreSQL 16"],
  open_questions: ["срок хранения?"],
  confidence: 0.85,
};

/** Ответ на инструмент раунда по тексту задачи. */
export function answerFor(tool: string, task: string, defaults: { vote?: unknown }): unknown {
  switch (tool) {
    case "submit_vote":
      return defaults.vote ?? { choice: "gRPC", confidence: 0.9, rationale: "protobuf уже есть" };
    case "submit_proposal":
      return proposal;
    case "submit_revision":
      return { ...proposal, changes: [] };
    case "submit_critique": {
      const labels = /\(метки ([A-Z0-9, ]+)\)/.exec(task)?.[1]?.split(", ") ?? [];
      return {
        reviews: labels.map((label) => ({
          label,
          strengths: ["учтён объём данных"],
          flaws: [{ text: "нет плана удаления старых партиций", severity: "minor" }],
          questions: [],
        })),
        ranking: labels,
      };
    }
    case "submit_synthesis":
      return {
        decision: "Партиционировать таблицу платежей по месяцам",
        decision_key: KEY,
        rationale: "Все участники пришли к одному решению",
        rejected_options: [{ key: "shard-by-tenant", why: "избыточно" }],
        risks: [{ risk: "горячая партиция", severity: "minor" }],
        open_questions: ["срок хранения?"],
        plan: [
          {
            step: "Миграция партиций",
            details: "декларативно по месяцам",
            files: ["db/migrations/0042.sql"],
          },
        ],
        confidence: 0.85,
      };
    case "submit_research":
      return {
        findings: [{ fact: "сервисы общаются по protobuf", source: "README.md:2" }],
        constraints: ["PostgreSQL 16"],
        options: [{ key: KEY, summary: "по месяцам" }],
        unknowns: ["срок хранения"],
      };
    case "submit_grouping": {
      const keys = [...task.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1]);
      return { groups: keys.map((k) => [k]), reason: "разные решения" };
    }
    case "submit_debate_turn":
      return {
        arguments: [{ claim: "сервисы уже общаются по protobuf", evidence: "README.md:2" }],
        rebuttals: [],
        concessions: ["другой вариант проще отлаживать"],
      };
    case "submit_judgement":
      return {
        scores: [{ criterion: "корректность", first: 6, second: 8, note: "protobuf уже есть" }],
        winner: "second",
        confidence: 0.8,
        rationale: "контракты уже в protobuf (README.md:2)",
        strongest_first: "простота отладки",
        strongest_second: "строгие контракты",
        conditions: ["появятся внешние клиенты без поддержки gRPC"],
      };
    case "submit_options":
      return { options: ["REST", "gRPC"], reason: "два протокола" };
    case "submit_review": {
      // «Ревьюер» находит заложенную SQL-инъекцию, если она есть в диффе.
      const vulnerable = /SELECT[^\n]*"\s*\+\s*req\./.test(task);
      return vulnerable
        ? {
            verdict: "fail",
            summary: "SQL-инъекция",
            findings: [
              {
                severity: "critical",
                title: "SQL-инъекция в /payments",
                file: "src/api.ts",
                line: 1,
                detail: "req.query.id конкатенируется в SQL",
                blocker: true,
              },
            ],
          }
        : { verdict: "pass", summary: "замечаний нет", findings: [] };
    }
    default:
      return {};
  }
}

export function fakeProvider(defaults: { vote?: unknown } = {}) {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-a" }, { id: "fake-b" }] }));
        return;
      }
      const chat = JSON.parse(body || "{}") as ChatRequest;
      requests.push(chat);
      const call = nextCall(chat, defaults);
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: chat.model };
      const chunks: unknown[] = call
        ? [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${String(requests.length)}`,
                        type: "function",
                        function: call,
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
        : [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: hostReply(chat) ?? "Готово." },
                  finish_reason: null,
                },
              ],
            },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
}

function nextCall(
  chat: ChatRequest,
  defaults: { vote?: unknown },
): { name: string; arguments: string } | undefined {
  const names = chat.tools?.map((t) => t.function.name) ?? [];
  const lastUser = chat.messages.map((m) => m.role).lastIndexOf("user");
  const task = text(chat.messages[lastUser]?.content);
  const calls = chat.messages
    .slice(lastUser + 1)
    .flatMap((m) => m.tool_calls ?? [])
    .map((c) => c.function.name);
  const isParticipant = names.some((n) => n.startsWith("council_submit_"));
  const isHost = names.includes("council_council_deliberate");
  if (isHost) return hostCall(chat, lastUser);
  const args = (o: unknown) => JSON.stringify(o);

  if (!isParticipant) {
    // Субагент: прочитать README и ответить текстом.
    return calls.includes("read") || !names.includes("read")
      ? undefined
      : { name: "read", arguments: args({ path: "README.md" }) };
  }
  const tool = /(submit_[a-z_]+)/.exec(task)?.[1];
  if (tool === undefined) return undefined; // служебный ход (например, результат субагента)
  const plan: { name: string; arguments: string }[] = [
    { name: "read", arguments: args({ path: ".env" }) },
    { name: "read", arguments: args({ path: "local-secrets/token.txt" }) },
    ...(names.includes("subagent")
      ? [
          {
            name: "subagent",
            arguments: args({
              agent: "council-explore",
              description: "изучить README",
              prompt: "Прочитай README.md и перескажи",
            }),
          },
        ]
      : []),
    { name: "read", arguments: args({ path: "README.md" }) },
    { name: `council_${tool}`, arguments: args(answerFor(tool, task, defaults)) },
  ];
  return plan[calls.length];
}

/** Тексты результатов инструментов, которые opencode вернул модели. */
export function toolResults(requests: ChatRequest[]): string[] {
  return requests.flatMap((r) =>
    r.messages.filter((m) => m.role === "tool").map((m) => text(m.content)),
  );
}

/**
 * Хост-агент opencode: на команду /council вызывает council_deliberate (короткий wait_s, чтобы
 * проверить council_wait), пока идёт прогресс — council_wait, затем отвечает текстом отчёта.
 */
function hostCall(
  chat: ChatRequest,
  lastUser: number,
): { name: string; arguments: string } | undefined {
  const after = chat.messages.slice(lastUser + 1);
  const lastTool = [...after].reverse().find((m) => m.role === "tool");
  if (!lastTool) {
    return {
      name: "council_council_deliberate",
      arguments: JSON.stringify({
        question: "Как партиционировать таблицу платежей?",
        mode: "consensus",
        context: { notes: "PostgreSQL 16", files: ["README.md"] },
        wait_s: 1,
      }),
    };
  }
  const result = text(lastTool.content);
  const runId = /council_wait с run_id="([^"]+)"/.exec(result)?.[1];
  if (runId)
    return {
      name: "council_council_wait",
      arguments: JSON.stringify({ run_id: runId, wait_s: 2 }),
    };
  return undefined; // итог получен — ответить текстом
}

/** Текст ответа хоста: отчёт из последнего результата council_* (как просит инструкция). */
export function hostReply(chat: ChatRequest): string | undefined {
  const tool = [...chat.messages].reverse().find((m) => m.role === "tool");
  const out = /<council-output[^>]*>\n([\s\S]*?)\n<\/council-output>/.exec(text(tool?.content));
  return out?.[1];
}
