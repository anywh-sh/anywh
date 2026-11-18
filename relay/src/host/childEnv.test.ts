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

test("a profile target replaces the relay's own config dirs; the relay's own home keeps them", () => {
  const saved = { ...process.env };
  try {
    process.env.CLAUDE_CONFIG_DIR = "/mine/claude";
    process.env.KIMI_CODE_HOME = "/mine/kimi";
    const own = buildChildEnv("/home/x/.legacy-home", [], () => {});
    assert.equal(own.HOME, "/home/x/.legacy-home");
    assert.equal(own.CLAUDE_CONFIG_DIR, "/mine/claude");
    const other = buildChildEnv({ home: "/home/x/.work-home" }, [], () => {});
    assert.equal(other.HOME, "/home/x/.work-home");
    assert.equal("CLAUDE_CONFIG_DIR" in other, false);
    assert.equal("KIMI_CODE_HOME" in other, false);
    const draft = buildChildEnv({ configDirs: { claude: "/draft/claude" } }, [], () => {});
    assert.equal(draft.CLAUDE_CONFIG_DIR, "/draft/claude");
    assert.equal("KIMI_CODE_HOME" in draft, false);
  } finally {
    process.env = saved;
  }
});
