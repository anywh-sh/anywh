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

// One binary, three programs (a second SEA would ship a second Node):
// `anywh-relay agent-host --profile <id>` runs the agent host instead of the
// relay, and `anywh-relay record-profile <profiles.json> <id> <label>` is
// add-profile.sh's registry write on a Mac that has no `node` of its own.
if (process.argv[2] === "agent-host") {
  process.argv.splice(2, 1);
  require("../dist/agentHost/main.js");
} else if (process.argv[2] === "record-profile") {
  const [path, id, label] = process.argv.slice(3);
  if (!path || !id || !label) {
    console.error("usage: anywh-relay record-profile <profiles.json> <id> <label>");
    process.exit(2);
  }
  require("../dist/host/recordProfile.js").recordProfile(path, id, label);
} else {
  require("../dist/server.js");
}
