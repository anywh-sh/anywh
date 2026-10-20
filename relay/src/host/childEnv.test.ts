import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv } from "./childEnv.js";

test("a child never inherits the agent host's configuration", () => {
  const saved = { ...process.env };
  try {
    process.env.ANYWH_PROFILE = "pessoal";
    process.env.ANYWH_AGENT_HOST_SOCKET = "/run/user/1000/anywh/agent-host-pessoal.sock";
    process.env.ANYWH_AGENT_HOST_DIR = "/home/x/.anywh-sessions/pessoal-agent-host";
    process.env.ANYWH_AGENT_HOST_ID = "pessoal";
    process.env.ANYWH_SESSIONS_ROOT = "/home/x/.anywh-sessions";
    const env = buildChildEnv(undefined, [], () => {});
    for (const name of ["ANYWH_PROFILE", "ANYWH_AGENT_HOST_SOCKET", "ANYWH_AGENT_HOST_DIR", "ANYWH_AGENT_HOST_ID", "ANYWH_SESSIONS_ROOT"]) {
      assert.equal(Object.keys(env).includes(name), false, name);
    }
  } finally {
    process.env = saved;
  }
});
