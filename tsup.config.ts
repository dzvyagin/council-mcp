import { defineConfig } from "tsup";

// Один самодостаточный файл на точку входа: запуск без npm install (нет корпоративного npm).
export default defineConfig({
  // plugin/lib — логика плагина opencode (защита путей, сводка, роутер), его импортирует файл плагина.
  entry: { "cli/index": "src/cli/index.ts", "plugin/lib": "src/plugin/lib.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  // CJS-зависимости (pino) зовут require(): в ESM-бандле даём им настоящий require.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __councilCreateRequire } from "node:module";',
      "const require = __councilCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
