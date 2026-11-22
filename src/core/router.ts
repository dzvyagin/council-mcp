/**
 * Роутер /council-auto: запрос → команда и параметры. Детерминированная таблица правил с
 * приоритетами (как classify_task у Claude Octopus): без вызова модели, мгновенно, объяснимо.
 * Тот же роутер даёт подсказку хука на обычные промпты (COUNCIL_AUTO_ROUTER=suggest).
 */

export type Command =
  | "council"
  | "council-debate"
  | "council-vote"
  | "council-review"
  | "council-embrace"
  | "council-discover"
  | "council-define"
  | "council-costs"
  | "council-status"
  | "council-usage"
  | "none";

export interface Route {
  command: Command;
  /** Параметры для council_deliberate / council_workflow. */
  args: Record<string, unknown>;
  confidence: "high" | "medium" | "low";
  reason: string;
}

interface Rule {
  command: Command;
  confidence: Route["confidence"];
  reason: string;
  test: RegExp;
}

const ARCH =
  /(схем[аеуы]\s+(бд|данных|базы)|таблиц|миграц|индекс|партици|шардир|сервис|микросервис|монолит|api\b|апи|контракт|протокол|grpc|rest\b|graphql|брокер|kafka|rabbit|очеред|хранилищ|кэш|cache|бд(?![а-яё])|база данных|postgres|oracle|mongo|redis|консистентн|транзакц|идемпотент|архитектур|выбор технолог|event sourcing|cqrs|saga|outbox)/i;

/** Порядок важен: первое совпадение побеждает. */
const RULES: Rule[] = [
  {
    command: "council-status",
    confidence: "high",
    reason: "вопрос о текущем процессе совета",
    test: /(статус|состояни[ея]|где мы|на какой фазе).{0,40}(совет|процесс|council|фаз)|^\s*(статус|status)\s*$/i,
  },
  {
    command: "council-usage",
    confidence: "high",
    reason: "вопрос о фактическом расходе",
    test: /(сколько|какой).{0,30}(потратил|израсходовал|ушло|расход)|usage|статистик[аи] расхода/i,
  },
  {
    command: "council-costs",
    confidence: "high",
    reason: "нужен прогноз до запуска",
    test: /(сколько (будет )?стоит|прогноз|оцени(ть)? (расход|стоимость|токены)|сколько (вызовов|токенов))/i,
  },
  {
    command: "council-review",
    confidence: "high",
    reason: "ревью изменений, go/no-go",
    test: /(ревью|review|проверь|посмотри|оцени)\s.{0,40}(дифф|diff|изменени|правк|pr\b|пулл?-?реквест|merge request|коммит|ветк)|go\s*\/?\s*no[- ]go|можно ли (выкатывать|мержить|релизить)|уязвимост[иь]\s.{0,20}(в изменени|в диффе)/i,
  },
  {
    command: "council-embrace",
    confidence: "high",
    reason: "полный цикл от исследования до реализации",
    test: /(от исследования до|полный цикл|под ключ|спроектируй и реализуй|продумай и сделай|от идеи до|double diamond|embrace)/i,
  },
  {
    command: "council-debate",
    confidence: "high",
    reason: "два явных варианта",
    test: /\s(или|vs\.?|versus|против)\s/i,
  },
  {
    command: "council-vote",
    confidence: "medium",
    reason: "быстрая развилка",
    test: /(быстро (выбери|реши)|проголосуй|голосовани|какой из (вариантов|этих)|выбери (один )?из)/i,
  },
  {
    command: "council-discover",
    confidence: "medium",
    reason: "сначала исследование",
    test: /(исследуй|разберись|изучи|какие (есть )?(варианты|подходы)|что (у нас )?есть по|research|discover)/i,
  },
  {
    command: "council-define",
    confidence: "medium",
    reason: "нужен план работ",
    test: /(спланируй|план (работ|реализации|миграции)|составь план|как (нам )?(внедрить|перейти|мигрировать))/i,
  },
];

/** «REST или gRPC», «Kafka vs RabbitMQ» → два варианта. */
export function extractOptions(request: string): [string, string] | undefined {
  const cleaned = request.replace(/[?!.]+\s*$/, "").replace(/^.*?:\s*/, "");
  const parts = cleaned.split(/\s+(?:или|vs\.?|versus|против)\s+/i);
  if (parts.length !== 2) return undefined;
  const tail = (s: string) =>
    s
      .split(/\s+(?:для|в|на|при|чтобы|—|-)\s+/i)[0]
      ?.trim()
      .split(/\s+/)
      .slice(-4)
      .join(" ");
  const head = (s: string) =>
    s
      .split(/[,;:]|\s+(?:для|в|на|при|чтобы|—)\s+/i)[0]
      ?.trim()
      .split(/\s+/)
      .slice(0, 4)
      .join(" ");
  const a = tail(parts[0] ?? "");
  const b = head(parts[1] ?? "");
  // «индекс или нет», «делать или не делать» — это не два варианта решения.
  if (!a || !b || /^(нет|не|да|без)(\s|$)/i.test(b)) return undefined;
  return [stripLead(a), b];
}

const stripLead = (s: string) =>
  s
    .replace(/^(что лучше|выбрать|выбор|использовать|брать|взять|делать|нам|ли)\s+/i, "")
    .replace(/^(что лучше|выбрать|использовать)\s+/i, "");

function flags(request: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const panel = /--panel\s+(3|5|7)|панел[ьи]\s+(?:из\s+)?(3|5|7)/i.exec(request);
  if (panel) out.panel = Number(panel[1] ?? panel[2]);
  if (/red[- ]?team|атак|уязвим|безопасност/i.test(request)) out.style = "red-team";
  else if (/для (руководств|руководител|cto|бизнеса)|кратко для/i.test(request))
    out.style = "executive";
  else if (/адвокат дьявола|против всех|жёстк|придир/i.test(request)) out.style = "adversarial";
  if (/--research-first|сначала (исследуй|изучи)/i.test(request)) out.research_first = true;
  return out;
}

export function route(request: string): Route {
  const text = request.trim();
  if (text === "") return { command: "none", args: {}, confidence: "low", reason: "пустой запрос" };
  const extra = flags(text);

  for (const rule of RULES) {
    if (!rule.test.test(text)) continue;
    if (rule.command === "council-debate") {
      const options = extractOptions(text);
      if (!options) continue; // «или» без двух внятных вариантов — дальше по правилам
      return {
        command: rule.command,
        args: { mode: "debate", question: text, options, swap_sides: true, ...extra },
        confidence: rule.confidence,
        reason: rule.reason,
      };
    }
    const args: Record<string, unknown> = { question: text, ...extra };
    if (rule.command === "council-review") Object.assign(args, { mode: "review" });
    if (rule.command === "council-vote") Object.assign(args, { mode: "vote" });
    if (rule.command === "council-discover") Object.assign(args, { mode: "discover" });
    if (rule.command === "council-define") Object.assign(args, { mode: "consensus", goal: "plan" });
    if (rule.command === "council-embrace") Object.assign(args, { task: text });
    return { command: rule.command, args, confidence: rule.confidence, reason: rule.reason };
  }

  if (ARCH.test(text)) {
    return {
      command: "council",
      args: { mode: "consensus", question: text, ...extra },
      confidence: "medium",
      reason: "архитектурное решение (данные, сервисы, контракты, технологии)",
    };
  }
  return {
    command: "none",
    args: {},
    confidence: "low",
    reason: "не похоже на ключевое решение — совет не нужен",
  };
}
