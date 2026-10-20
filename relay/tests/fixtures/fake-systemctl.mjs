#!/usr/bin/env node
// Second sanctioned mock boundary, alongside `fake-claude.mjs` (see
// .anywh/skills/tests/SKILL.md) — stands in for the real `systemctl`
// binary via the `SYSTEMCTL_BIN` env var (relay/src/server.ts), used only by
// `DELETE /control/profiles/:id`. Added after a real incident (2026-09-07):
// an integration test hitting that route with the real `systemctl` disabled
// and stopped the operator's actual live `anywh-relay@trabalho` service,
// SIGKILLing an in-flight `claude` conversation. `systemctl --user` has no
// concept of "this is a test" the way an isolated `$HOME`/port/env-dir does
// for everything else this route touches — there's no sandboxed form of the
// real command to call instead, so (like the `claude` process itself) it
// gets a fake substituted in tests, never the real binary.
//
// Always succeeds (exit 0, no output) — the route only cares about the exit
// code (best-effort cleanup either way, see server.ts), and no test in this
// repo asserts on systemd's own state. FAKE_SYSTEMCTL_ARGV_FILE, if set,
// gets each invocation's argv appended as one JSON array per line, so a test
// can check which units the relay asked to disable.
import { appendFileSync } from "node:fs";

// FAKE_SYSTEMCTL_HOST_DELAY_MS, if set, makes a call naming an
// `anywh-agent-host@` unit take that long, like a real `disable --now` that
// waits for the host to drain.
if (process.env.FAKE_SYSTEMCTL_ARGV_FILE) {
  appendFileSync(process.env.FAKE_SYSTEMCTL_ARGV_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
}
const delay = Number(process.env.FAKE_SYSTEMCTL_HOST_DELAY_MS ?? 0);
if (delay > 0 && process.argv.some((arg) => arg.startsWith("anywh-agent-host@"))) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}
process.exit(0);
