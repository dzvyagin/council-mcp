// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Ядро переиспользуется вне MCP (CLI, веб-агент): транспортные SDK сюда не попадают.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@modelcontextprotocol/*"],
              message: "core не зависит от MCP SDK: используй адаптер в src/mcp.",
            },
            {
              group: ["@agentclientprotocol/*"],
              message: "core не знает, как запущены участники: ACP — в src/drivers/acp.",
            },
            {
              group: ["**/drivers/**", "**/mcp/**", "**/cli/**"],
              message: "core не импортирует адаптеры.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
