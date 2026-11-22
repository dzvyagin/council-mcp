import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "tsup";

// Один самодостаточный файл на точку входа: запуск без npm install (нет корпоративного npm).
// dist/ коммитится: репозиторий сам является пакетом плагина (как у Claude Octopus).
export default defineConfig((options) => ({
  // opencode/plugin — плагин opencode V2 (точка входа пакета для `opencode plugin add`).
  entry: { "cli/index": "src/cli/index.ts", "opencode/plugin": "src/opencode/plugin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  // Skill регистрирует плагин из файла рядом с собой.
  onSuccess: async () => {
    const out = options.outDir ?? "dist";
    await copyFile("integrations/skills/council/SKILL.md", join(out, "opencode/SKILL.md"));
  },
  // CJS-зависимости (pino) зовут require(): в ESM-бандле даём им настоящий require.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __councilCreateRequire } from "node:module";',
      "const require = __councilCreateRequire(import.meta.url);",
    ].join("\n"),
  },
}));
