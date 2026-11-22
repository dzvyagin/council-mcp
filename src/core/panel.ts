import { seededRandom } from "./anonymize.js";
import type { ModelConfig, PanelSize, Style } from "./config.js";

/**
 * Панель совета: персоны по стилю, распределённые по моделям. Больше персон, чем моделей, —
 * модель играет несколько персон; каждая персона — отдельное анонимное место со своей сессией.
 */

export interface Persona {
  id: string;
  name: string;
  /** Короткая подпись для отчёта. */
  short: string;
  focus: string;
  /** Может наложить вето на critical-недостаток. */
  vetoPower: boolean;
}

const persona = (
  id: string,
  name: string,
  short: string,
  focus: string,
  vetoPower = false,
): Persona => ({
  id,
  name,
  short,
  focus,
  vetoPower,
});

export const PERSONAS: Record<string, Persona> = {
  architect: persona(
    "architect",
    "Архитектор распределённых систем",
    "архитектор",
    "границы сервисов, консистентность, отказоустойчивость, контракты",
  ),
  dba: persona(
    "dba",
    "Архитектор данных / DBA",
    "DBA",
    "модель данных, индексы, миграции, нагрузка, специфика СУБД",
  ),
  sre: persona(
    "sre",
    "SRE",
    "SRE",
    "эксплуатация, наблюдаемость, отказы и откат, ёмкость, дежурства",
    true,
  ),
  security: persona(
    "security",
    "Инженер по безопасности",
    "безопасность",
    "модель угроз, доступы, секреты, требования регулятора, аудит",
    true,
  ),
  lead: persona(
    "lead",
    "Ведущий разработчик",
    "лид",
    "реализуемость, объём работ, тестируемость, влияние на кодовую базу",
  ),
  analyst: persona(
    "analyst",
    "Бизнес-аналитик",
    "аналитик",
    "ценность для бизнеса, сроки, стоимость изменений, риски для продукта",
  ),
  attacker: persona(
    "attacker",
    "Red team: внешний атакующий",
    "red team",
    "как злоумышленник сломает решение снаружи: входы, API, цепочки уязвимостей",
  ),
  insider: persona(
    "insider",
    "Red team: инсайдер и худшие сценарии",
    "инсайдер",
    "злоупотребление правами изнутри, каскадные отказы, худшие сценарии эксплуатации",
  ),
  devil: persona(
    "devil",
    "Адвокат дьявола",
    "адвокат дьявола",
    "сильнейшие аргументы против популярного решения и в пользу отвергнутых вариантов",
  ),
};

/** Порядок персон по стилю: панель N берёт первые N. */
export const STYLE_PERSONAS: Record<Style, string[]> = {
  balanced: ["architect", "dba", "sre", "security", "lead", "analyst", "devil"],
  adversarial: ["architect", "sre", "devil", "dba", "security", "lead", "analyst"],
  "red-team": ["architect", "attacker", "insider", "security", "sre", "dba", "devil"],
  executive: ["architect", "analyst", "sre", "dba", "security", "lead", "devil"],
  implementation: ["architect", "lead", "dba", "sre", "security", "analyst", "devil"],
};

export interface SeatSpec {
  persona: Persona;
  model: ModelConfig;
}

export interface PanelOptions {
  models: ModelConfig[];
  panel: PanelSize;
  style: Style;
  seed: string;
  /** Переопределения из council.config.json. */
  personas?: Record<string, { [K in keyof Omit<Persona, "id">]?: Persona[K] | undefined }>;
}

export function resolvePersonas(overrides: PanelOptions["personas"] = {}): Record<string, Persona> {
  const result: Record<string, Persona> = { ...PERSONAS };
  for (const [id, o] of Object.entries(overrides)) {
    const base = result[id];
    if (!base) continue;
    result[id] = {
      ...base,
      ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
      id,
    };
  }
  return result;
}

/** Персоны стиля → модели по кругу со сдвигом по seed: повтор запуска даёт ту же раскладку. */
export function buildPanel(options: PanelOptions): SeatSpec[] {
  const catalog = resolvePersonas(options.personas);
  const ids = STYLE_PERSONAS[options.style].slice(0, options.panel);
  const offset = Math.floor(seededRandom(`${options.seed}:panel`)() * options.models.length);
  return ids.map((id, i) => {
    const p = catalog[id];
    const model = options.models[(i + offset) % options.models.length];
    if (!p || !model) throw new Error(`панель: нет персоны ${id} или модели`);
    return { persona: p, model };
  });
}

/** Сколько мест каждая модель получила в панели. */
export function seatsPerModel(seats: SeatSpec[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of seats) m.set(s.model.id, (m.get(s.model.id) ?? 0) + 1);
  return m;
}
