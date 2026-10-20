# Manual smoke scripts

Standalone scripts for manually exercising a running relay (`npm run dev` in another terminal) — not part of `npm test`, no assertions/exit-code contract, just console output to eyeball. Run each with `node scripts/manual/<file>.mjs` from `relay/`; see the comment at the top of each file for what it checks and any extra arguments.

`test-background-job.mjs` drives the real `claude` binary through the `anywh-bg` follow-up flow (report turn, `anywh-bg stop` staying silent, exit 143 without evidence still reported, exit 1 always reported). Start a relay on a free port first and pass it as `RELAY_PORT`; it costs real model turns and takes a few minutes.

`test-long-approval.mjs` leaves a real tool approval (a `Write` on Haiku) pending for ~2 minutes and checks it is still answerable and the tool then runs — the live counterpart of the `timeout` assertion in `mcpSpawnConfig.test.ts`. It starts its own relay on a free port with throwaway data and a temp HOME (`RELAY_HOME_OVERRIDE`; only the login file `~/.claude/.credentials.json` is copied in) in a temp dir (run `npm run build` first); exits non-zero on failure.

`test-agent-host-real.mjs` drives the agent host (in-process, own socket and data under a temp dir) against the real `claude` on Haiku: one turn, an interrupt with a foreground command in flight, hibernate + resume with `--resume`, and a graceful stop with a background command running, printing whether anything of the agent survived. Real `$HOME` (for the login), temp cwd, four short turns. Run with `node --import tsx scripts/manual/test-agent-host-real.mjs`.

`check-codex-dynamic-tools.mjs` regenerates the installed `codex`'s app-server bindings (`codex app-server generate-ts --experimental`, no model runs, no quota spent) and compares the shapes the room tools rely on for a Codex agent (dynamic tools, `item/tool/call`, the `dynamicToolCall` item) with the ones recorded in `tests/fixtures/codex-app-server-0.154.0-dynamic-tools.json`; exits 1 and prints the difference when they drifted. Run it after a Codex update, before trusting a Codex principal with that version.
