import { test } from "node:test";
import assert from "node:assert/strict";
import { spentWindowResetAt } from "./windows.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;

test("a limit waits for the spent window that resets last", () => {
  assert.equal(
    spentWindowResetAt(
      [
        { durationMins: 300, usedPercent: 100, resetsAt: NOW + 2 * HOUR },
        { durationMins: 10080, usedPercent: 95, resetsAt: NOW + 30 * HOUR },
      ],
      NOW,
    ),
    NOW + 30 * HOUR,
  );
});

test("a window not spent, past, unknown or absurdly far says nothing", () => {
  assert.equal(spentWindowResetAt([{ durationMins: 300, usedPercent: 40, resetsAt: NOW + HOUR }], NOW), undefined);
  assert.equal(spentWindowResetAt([{ durationMins: 300, usedPercent: 100, resetsAt: NOW - HOUR }], NOW), undefined);
  assert.equal(spentWindowResetAt([{ durationMins: 300, usedPercent: 100, resetsAt: null }], NOW), undefined);
  assert.equal(spentWindowResetAt([{ durationMins: 10080, usedPercent: 100, resetsAt: NOW + 40 * 24 * HOUR }], NOW), undefined);
  assert.equal(spentWindowResetAt([], NOW), undefined);
});
