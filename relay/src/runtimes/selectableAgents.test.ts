import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogProbeDue, CATALOG_RETRY_AFTER_FAILURE_MS, type CatalogProbeRecord } from "./selectableAgents.js";

const TTL = 6 * 3_600_000;
const known: CatalogProbeRecord = { at: 1_000, version: "1.0.0", published: "{}" };
const failed: CatalogProbeRecord = { at: 1_000, version: "1.0.0" };

test("catalogProbeDue: an agent never probed is due", () => {
  assert.equal(catalogProbeDue(undefined, "1.0.0", 0, TTL), true);
});

test("catalogProbeDue: a known catalog on the same version is fresh until the TTL", () => {
  assert.equal(catalogProbeDue(known, "1.0.0", 1_000 + TTL - 1, TTL), false);
  assert.equal(catalogProbeDue(known, "1.0.0", 1_000 + TTL, TTL), true);
});

test("catalogProbeDue: a version change is due inside the TTL", () => {
  assert.equal(catalogProbeDue(known, "1.0.1", 1_001, TTL), true);
});

test("catalogProbeDue: a probe that found nothing waits the failure delay, whatever the TTL", () => {
  assert.equal(catalogProbeDue(failed, "1.0.0", 1_000 + CATALOG_RETRY_AFTER_FAILURE_MS - 1, TTL), false);
  assert.equal(catalogProbeDue(failed, "1.0.0", 1_000 + CATALOG_RETRY_AFTER_FAILURE_MS, TTL), true);
});
