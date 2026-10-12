import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-refresh": reactRefresh },
    rules: {
      "react-refresh/only-export-components": "warn",
      // react-hooks v7 ships the new compiler-era rules; two of them flag
      // legitimate patterns here (a Date.now() seed for a ref, and syncing
      // derived theme state from a Tauri event), so they stay off.
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      // Keep functions reviewable: flags anything over the threshold so it can
      // be split rather than growing unbounded.
      complexity: ["warn", 15],
    },
  },
  {
    // Node CLI scripts.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
);
