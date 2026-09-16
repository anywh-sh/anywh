import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "tailnet-sidecar/**", "tests/e2e/**/*.js", "scripts/**/*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The tsconfig's noUnusedLocals/noUnusedParameters already do this.
      "@typescript-eslint/no-unused-vars": "off",

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Violating this is a bug (stale closure, wrong render count), not
      // debt — never goes in the suppression baseline.
      "react-hooks/rules-of-hooks": "error",
      // `warn`, and never run through `--fix`: AppShell's `sidebarHandlersRef`
      // and the other ref-mirrors it uses to avoid re-rendering the sidebar
      // are deliberate deps omissions, judged case by case against
      // tests/ui/sidebarRenderCost.test.tsx, not something a bulk pass
      // should "correct".
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // node:test/vitest's own idiom at module scope; same reasoning as the
    // relay config.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    files: ["eslint.config.js", "wdio.conf.js", "vite.config.ts", "vitest.config.ts", "vitest.perf.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // wdio.conf.js runs partly as a Node config module (`process`) and
    // partly as WebdriverIO's own runtime, which injects `browser`/`$` as
    // globals into that same file — plus `window`/`localStorage` inside its
    // `browser.execute(() => ...)` callbacks, which actually run in the
    // Tauri webview, not Node. `no-undef` can't tell scopes like that apart,
    // so all five are declared file-wide.
    files: ["wdio.conf.js"],
    languageOptions: {
      globals: { process: "readonly", browser: "readonly", $: "readonly", window: "readonly", localStorage: "readonly" },
    },
  },
);
