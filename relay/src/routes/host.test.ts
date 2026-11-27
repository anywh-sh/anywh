import { test } from "node:test";
import assert from "node:assert/strict";
import { relayFeatures, updateSupportOf } from "./host.js";

test("self_update is named only by a relay that can install a release over itself", () => {
  assert.ok(relayFeatures(true).includes("self_update"));
  assert.ok(!relayFeatures(false).includes("self_update"));
  // Everything else stays either way.
  assert.ok(relayFeatures(false).includes("bots"));
  assert.ok(relayFeatures(false).includes("chat_media"));
});

test("updateSupport names why a relay cannot update itself, and stays supported through an install", () => {
  assert.equal(updateSupportOf({ state: "unsupported", reason: "managed_elsewhere" }), "managed_elsewhere");
  assert.equal(updateSupportOf({ state: "unsupported", reason: "not_installer_layout" }), "not_installer_layout");
  assert.equal(updateSupportOf({ state: "idle" }), "supported");
  assert.equal(updateSupportOf({ state: "failed", version: "1.2.3", code: "x", message: "y" }), "supported");
});
