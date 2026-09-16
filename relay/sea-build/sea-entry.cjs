// The macOS SEA binary's actual entrypoint (build.mjs bundles this, not
// dist/server.js directly). Node SEA doesn't process runtime CLI flags —
// `--env-file-if-exists`, the one server.ts's normal launch paths rely on
// to load a profile's `.env`, is silently ignored here. The Homebrew
// formula's `service do` block sets `RELAY_ENV_FILE` as a plain
// environment variable instead (something a SEA binary *does* still see,
// since it's inherited from the OS process, not parsed by Node), and this
// applies it before requiring server.ts — a plain CJS `require()` (not an
// ESM `import`, which esbuild would hoist ahead of this file's own code)
// is what guarantees that ordering: server.ts's own module-level
// `process.env` reads, and everything it imports, only run once this line
// actually executes.
const { readFileSync } = require("node:fs");
const { applyEnvFileContent } = require("../dist/host/envFile.js");

const envFilePath = process.env.RELAY_ENV_FILE;
if (envFilePath) {
  try {
    applyEnvFileContent(readFileSync(envFilePath, "utf8"), process.env);
  } catch {
    // Matches --env-file-if-exists: a missing file isn't an error, that's
    // the "-if-exists" half of the contract this stands in for.
  }
}

require("../dist/server.js");
