import { copyFile } from "node:fs/promises";

import { defineConfig } from "tsup";

// Один самодостаточный файл на точку входа: запуск без npm install (нет корпоративного npm).
export default defineConfig({
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
    await copyFile("integrations/skills/council/SKILL.md", "dist/opencode/SKILL.md");
  },
  // CJS-зависимости (pino) зовут require(): в ESM-бандле даём им настоящий require.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __councilCreateRequire } from "node:module";',
      "const require = __councilCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
