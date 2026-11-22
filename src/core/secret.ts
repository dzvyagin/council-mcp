import { inspect } from "node:util";

const MASK = "***";

/**
 * Обёртка над секретом: при логировании, сериализации и выводе в консоль показывает `***`.
 * Значение доступно только через явный вызов `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}
