// Встраивает integrations/** в src/cli/templates.generated.ts: `council setup` работает
// из одного файла бандла, без папки integrations рядом. Запуск: node scripts/gen-templates.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = join(root, "integrations");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(base)
  .map((p) => [relative(base, p).split("\\").join("/"), readFileSync(p, "utf8")])
  .sort(([a], [b]) => a.localeCompare(b));

export const output = `// Сгенерировано scripts/gen-templates.mjs из integrations/ — не редактировать вручную.
export const TEMPLATES: Record<string, string> = ${JSON.stringify(Object.fromEntries(files), null, 2)};
`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(root, "src/cli/templates.generated.ts"), output);
  console.log(`templates: ${String(files.length)} файлов`);
}
