import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The rules below are demoted from error to warn for M1. They flag
      // pre-M1 code patterns (setState-in-effect, refs-during-render,
      // file exports that prevent fast refresh) that are real but require
      // case-by-case refactoring. The dashboard state consolidation
      // milestone (M9) will work through them and re-promote each rule
      // to error as it's cleaned up.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-refresh/only-export-components": "warn",
    },
  },
  {
    // ANSI parsing tests legitimately match \x1b control characters.
    files: ["src/lib/__tests__/ansi.test.ts"],
    rules: {
      "no-control-regex": "off",
      "no-regex-spaces": "off",
    },
  },
]);
