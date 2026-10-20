// The host's shutdown budget and its systemd unit must agree: systemd
// SIGKILLs the unit after TimeoutStopSec, and the user manager itself
// (user@.service) gives all user units about 90 s when the session ends.
// A drain that outlasts either is cut short — agents then come back as
// `host_restart` instead of hibernated, which is safe but avoidable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_DRAIN_GRACE_MS, DEFAULT_STOP_GRACE_MS, DRAIN_INTERRUPT_GRACE_MS } from "./agentHost.js";

const UNIT = resolve(import.meta.dirname, "../../../infra/systemd/anywh-agent-host@.service.template");
const USER_MANAGER_STOP_BUDGET_S = 90;

test("the default drain fits inside the unit's TimeoutStopSec, which fits inside the user manager's own budget", () => {
  const match = /^TimeoutStopSec=(\d+)$/m.exec(readFileSync(UNIT, "utf8"));
  assert.ok(match, "the unit sets TimeoutStopSec");
  const timeoutStopSec = Number(match[1]);
  const worstCaseDrainS = (DEFAULT_DRAIN_GRACE_MS + DRAIN_INTERRUPT_GRACE_MS + DEFAULT_STOP_GRACE_MS) / 1000;
  assert.ok(worstCaseDrainS + 5 <= timeoutStopSec, `drain may take ${worstCaseDrainS}s, unit allows ${timeoutStopSec}s`);
  assert.ok(timeoutStopSec < USER_MANAGER_STOP_BUDGET_S, `TimeoutStopSec=${timeoutStopSec} exceeds the user manager's ~${USER_MANAGER_STOP_BUDGET_S}s`);
  assert.ok(DEFAULT_DRAIN_GRACE_MS < 80_000);
});
