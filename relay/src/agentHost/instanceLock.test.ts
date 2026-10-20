import { test } from "node:test";
import assert from "node:assert/strict";
import { instanceLockName } from "./instanceLock.js";

test("the same profile of two users never maps to the same lock name", () => {
  assert.notEqual(instanceLockName("host-id:default", 1000), instanceLockName("host-id:default", 1001));
  assert.equal(instanceLockName("host-id:default", 1000), instanceLockName("host-id:default", 1000));
  assert.notEqual(instanceLockName("host-id:default", 1000), instanceLockName("host-id:other", 1000));
});
