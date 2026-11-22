import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Служебная папка `.council/`. При создании кладём в неё `.gitignore` с `*`, чтобы транскрипты
 * не попали в коммит даже до `/council-setup` (который добавит `.council/` в корневой .gitignore).
 */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(join(stateDir, "runs"), { recursive: true });
  try {
    await writeFile(join(stateDir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}
