import { describe, expect, it } from "vitest";

import { extractOptions, route } from "../src/core/router.js";

describe("route: 10+ типовых запросов", () => {
  it.each([
    ["Как партиционировать таблицу платежей на 2 млрд строк?", "council"],
    ["REST или gRPC для внутреннего API между сервисами?", "council-debate"],
    ["Kafka vs RabbitMQ для событий биллинга", "council-debate"],
    ["Проверь изменения в текущей ветке перед мержем", "council-review"],
    ["Можно ли выкатывать этот PR? go/no-go", "council-review"],
    ["Спроектируй и реализуй outbox для платежей, полный цикл", "council-embrace"],
    ["Быстро выбери из трёх библиотек для ретраев", "council-vote"],
    ["Исследуй, какие есть варианты хранения аудита", "council-discover"],
    ["Составь план миграции с Oracle на PostgreSQL", "council-define"],
    ["Сколько будет стоить совет панелью 7 по выбору брокера?", "council-costs"],
    ["Какой статус у процесса совета?", "council-status"],
    ["Сколько мы потратили токенов на совет за неделю?", "council-usage"],
    ["Поправь опечатку в README", "none"],
    ["Почему падает тест test_login?", "none"],
  ])("%s → %s", (request, command) => {
    expect(route(request).command).toBe(command);
  });
});

describe("route: параметры", () => {
  it("debate — два варианта и swap_sides", () => {
    expect(route("REST или gRPC для внутреннего API?").args).toMatchObject({
      mode: "debate",
      options: ["REST", "gRPC"],
      swap_sides: true,
    });
  });

  it("флаги: панель, red-team, executive, research_first", () => {
    expect(route("Выбор хранилища, панель из 7, сначала изучи код").args).toMatchObject({
      panel: 7,
      research_first: true,
    });
    expect(route("Ревью изменений на уязвимости").args).toMatchObject({
      mode: "review",
      style: "red-team",
    });
    expect(route("Какую БД выбрать — кратко для руководства").args).toMatchObject({
      style: "executive",
    });
  });

  it("«или» без двух вариантов — не debate", () => {
    expect(
      route(
        "Нужен ли индекс или нет на таблице заказов, подумай про миграции и нагрузку и ещё много всего",
      ).command,
    ).not.toBe("council-debate");
  });

  it("extractOptions", () => {
    expect(extractOptions("Что лучше: Kafka или RabbitMQ?")).toEqual(["Kafka", "RabbitMQ"]);
    expect(extractOptions("монолит vs микросервисы для ядра")).toEqual(["монолит", "микросервисы"]);
    expect(extractOptions("просто вопрос")).toBeUndefined();
  });
});
