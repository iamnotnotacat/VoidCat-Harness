import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  { ...js.configs.recommended, files: ["**/*.{js,cjs,mjs}"] },
  ...tseslint.configs.recommended,
  {
    ...reactHooks.configs.flat.recommended,
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
  },
  {
    files: ["desktop/**/*.cjs", "tests/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
