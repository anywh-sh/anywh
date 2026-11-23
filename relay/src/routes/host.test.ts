import { test } from "node:test";
import assert from "node:assert/strict";
import { relayFeatures } from "./host.js";

test("self_update is named only by a relay that can install a release over itself", () => {
  assert.ok(relayFeatures(true).includes("self_update"));
  assert.ok(!relayFeatures(false).includes("self_update"));
  // Everything else stays either way.
  assert.ok(relayFeatures(false).includes("bots"));
});
