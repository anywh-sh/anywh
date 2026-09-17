import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";

// The fronteira this repo is selling to a self-hosting contributor: adding a
// second agent CLI touches exactly one folder under runtimes/defs/. These
// zones are the enforcement for that promise — see docs/invariants.md for
// the full "who/where/orchestration" reasoning behind each line.
//
// The two reverse-direction violations this comment used to document
// (runtimes/defs/claude/transcriptReader.ts -> session/sharedSession.ts, and
// host/backgroundJobs.ts -> runtimes/defs/claude/session.ts) are gone as of
// Phase 7 — both now depend only on protocol/agent-event.ts.
//
// Everything under src/ except runtimes/defs/**, spelled out rather than
// negated: the last zone below needs "every file that isn't inside a def"
// as its target, and an explicit list is honest about needing an update the
// day a new top-level folder shows up — protocol/, routes/, ws/ and
// runtimes/streams/ (Phases 1/3/7) already had to be added here once.
const EVERYTHING_BUT_DEFS = [
  "src/server.ts",
  "src/lifecycle.ts",
  "src/host/**",
  "src/session/**",
  "src/bridges/**",
  "src/fs/**",
  "src/protocol/**",
  "src/routes/**",
  "src/ws/**",
  "src/runtimes/executables.ts",
  "src/runtimes/probes/**",
  "src/runtimes/streams/**",
];

// `except` globs are matched against the resolved *absolute* import path
// (see eslint-plugin-import-x's no-restricted-paths source), so a pattern
// without a leading `/` never matches — has to be anchored to this file's
// own directory the same way `target`/`from` are.
const HERE = import.meta.dirname;
const DEFS_INDEX_EXCEPT = [`${HERE}/src/runtimes/defs/*/index.ts`];

const ZONES = [
  { target: "src/host/**", from: "src/session/**" },
  { target: "src/host/**", from: "src/runtimes/**" },
  { target: "src/session/**", from: "src/runtimes/defs/**", except: DEFS_INDEX_EXCEPT },
  { target: "src/fs/**", from: "src/session/**" },
  { target: "src/fs/**", from: "src/runtimes/**" },
  { target: "src/bridges/**", from: "src/runtimes/defs/**" },
  // The mirror of the session/ rule above: a def is data + spawn-shaped
  // logic, never orchestration. Without this, the reverse-direction arrows
  // this repo is trying to make visible would import freely in this
  // direction and only get caught going the other way.
  { target: "src/runtimes/defs/**", from: "src/session/**" },
  // Nothing outside a def may reach past its own index.ts barrel — the
  // clause that keeps a second agent's private format from leaking the way
  // Claude's transcript shape once did.
  { target: EVERYTHING_BUT_DEFS, from: "src/runtimes/defs/claude/*", except: DEFS_INDEX_EXCEPT },
];

// Billed credentials (BILLED_CREDENTIAL_VARS in runtimes/executables.ts)
// must only ever be read in the one file that strips them from a child's
// env. A second read site is how a leak starts — this makes a new one a
// lint error instead of a code-review hope.
const CREDENTIAL_VAR_NAMES = "ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY";

export default tseslint.config(
  {
    // scripts/ and sea-build/ are plain Node .mjs, out of scope for now
    // (neither is under tsconfig.eslint.json's include). The two fixture
    // .mjs files are the same story — fixtures, not doctrine.
    ignores: ["dist/**", "node_modules/**", "scripts/**", "sea-build/**", "tests/fixtures/*.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Only the plugin's resolver + the one rule this repo actually wants —
    // `flatConfigs.recommended`/`.typescript` bring a dozen unrelated import
    // style rules (duplicate imports, named-as-default, ...) that aren't
    // one of the five groups this config exists for.
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver({ project: "./tsconfig.eslint.json" })],
    },
    rules: {
      // The two tsconfig flags already do this job; a second reporter here
      // would just double every finding.
      "@typescript-eslint/no-unused-vars": "off",

      // Async: runTurn and the broadcast helpers are 20+ `send*`/`await`
      // call sites in a WS server — a dropped promise here is a lost
      // message with no stack trace, not a visible crash.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // A new AgentEvent/ExecPlan variant becomes a compile error in every
      // switch that doesn't handle it yet, instead of a silently-skipped case.
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      "import-x/no-restricted-paths": ["error", { zones: ZONES }],

      "no-restricted-syntax": [
        "error",
        {
          selector: `MemberExpression[object.name='env'][property.name=/^(${CREDENTIAL_VAR_NAMES})$/], MemberExpression[object.property.name='env'][property.name=/^(${CREDENTIAL_VAR_NAMES})$/]`,
          message: "Billed credentials are read/stripped only in runtimes/executables.ts (BILLED_CREDENTIAL_VARS/stripBilledCredentials) — reading one elsewhere risks it leaking into a spawned child.",
        },
      ],
    },
  },
  {
    // The one file allowed to name these vars: it owns strip and the list.
    files: ["src/runtimes/executables.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // node:test's own idiom: `test("...", async () => {...})` at module
    // scope returns a promise the test runner tracks itself, not one this
    // file drops. The rule stays strict everywhere it might catch a real
    // bug — a turn's own `send*`/`broadcast*` call sites, in particular.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    // Not part of tsconfig.eslint.json's project — plain config, no type info.
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
