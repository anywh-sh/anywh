# Manual smoke scripts

Standalone scripts for manually exercising a running relay (`npm run dev` in another terminal) — not part of `npm test`, no assertions/exit-code contract, just console output to eyeball. Run each with `node scripts/manual/<file>.mjs` from `relay/`; see the comment at the top of each file for what it checks and any extra arguments.

`test-background-job.mjs` drives the real `claude` binary through the `anywh-bg` follow-up flow (report turn, `anywh-bg stop` staying silent, exit 143 without evidence still reported, exit 1 always reported). Start a relay on a free port first and pass it as `RELAY_PORT`; it costs real model turns and takes a few minutes.
