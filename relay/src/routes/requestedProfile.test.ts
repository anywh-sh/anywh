import { test } from "node:test";
import assert from "node:assert/strict";
import { readRequestedProfile } from "./requestedProfile.js";

test("?profile=<this relay's own id> is this relay's own profile, under the same login key as no profile at all", () => {
  const saved = process.env.ANYWH_PROFILE;
  process.env.ANYWH_PROFILE = "pessoal";
  try {
    const own = readRequestedProfile(new URL("http://relay/agent-login?profile=pessoal"), undefined);
    const bare = readRequestedProfile(new URL("http://relay/agent-login"), undefined);
    assert.ok(!("error" in own) && !("error" in bare));
    assert.equal(own.own, true);
    assert.equal(own.key, bare.key);
  } finally {
    if (saved === undefined) delete process.env.ANYWH_PROFILE;
    else process.env.ANYWH_PROFILE = saved;
  }
});
