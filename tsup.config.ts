import { defineConfig } from "tsup";

// Один самодостаточный файл на точку входа: запуск без npm install (нет корпоративного npm).
export default defineConfig({
  entry: { "cli/index": "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
