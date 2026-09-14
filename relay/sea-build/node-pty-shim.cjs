// A Node SEA binary's `require("node-pty")` resolves against nothing —
// the whole relay is a single bundled file with no filesystem location of
// its own to search from, so a bare `require` for anything but a Node
// builtin throws `ERR_UNKNOWN_BUILTIN_MODULE`. `node-pty` also can't be
// bundled into the blob itself: it's a native addon (`pty.node`), and Node
// SEA only supports shipping those as real files the running binary loads
// from disk, not as inlined bytes.
//
// `build.mjs` points esbuild's `--alias:node-pty` at this file instead of
// the real package, so every `require("node-pty")` in the bundled code
// calls into this shim, which does the one thing plain `require` can't:
// build its own module resolution scope rooted at a real path — the
// `node_modules/node-pty` this binary ships flat beside itself (see
// `resolveShipped` in `src/paths.ts` for the same convention applied to
// this relay's own scripts and `infra/`).
const { createRequire } = require("node:module");
const path = require("node:path");

const nativeRequire = createRequire(path.join(path.dirname(process.execPath), "node_modules", "node-pty", "package.json"));
module.exports = nativeRequire("node-pty");
