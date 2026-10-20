// The host's shutdown budget and its systemd unit must agree: systemd
// SIGKILLs the unit after TimeoutStopSec, and the user manager itself
// (user@.service) gives user units about 90 s when the session ends. A
// drain that outlasts either is cut short — agents then come back as
// `host_restart` instead of hibernated: safe, but avoidable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { worstCaseShutdownMs } from "./agentHost.js";

const UNIT = resolve(import.meta.dirname, "../../../infra/systemd/anywh-agent-host@.service.template");
const USER_MANAGER_STOP_BUDGET_S = 90;

test("the worst-case shutdown fits in 70 s, inside the unit's TimeoutStopSec, inside the user manager's budget", () => {
  const match = /^TimeoutStopSec=(\d+)$/m.exec(readFileSync(UNIT, "utf8"));
  assert.ok(match, "the unit sets TimeoutStopSec");
  const timeoutStopMs = Number(match[1]) * 1000;
  // Built from the same constants the shutdown path uses: raising any grace
  // without adjusting the others or the unit makes this fail.
  const worst = worstCaseShutdownMs();
  assert.ok(worst <= 70_000, `worst-case shutdown ${worst} ms`);
  assert.ok(worst + 5_000 <= timeoutStopMs, `worst-case shutdown ${worst} ms, unit allows ${timeoutStopMs} ms`);
  assert.ok(timeoutStopMs < USER_MANAGER_STOP_BUDGET_S * 1000, `TimeoutStopSec exceeds the user manager's ~${USER_MANAGER_STOP_BUDGET_S}s`);
});
