import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptLimitLine } from "./transcriptLimits.js";

// A refusal as Claude Code 2.1.303 writes it, redacted: ids are
// placeholders, and the conversation fields are reduced to what matters.
const REFUSAL = {
  parentUuid: "00000000-0000-4000-8000-000000000001",
  isSidechain: false,
  type: "assistant",
  uuid: "00000000-0000-4000-8000-000000000002",
  timestamp: "2026-10-30T03:31:47.112Z",
  message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 1:10am" }] },
  requestId: "req_redacted",
  apiError: "usage_limit_reached",
  apiErrorParams: {
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1793333400,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
    },
  },
  isApiErrorMessage: true,
};

test("a recorded refusal becomes its window at 100 %, dated by the entry", () => {
  assert.deepEqual(parseTranscriptLimitLine(JSON.stringify(REFUSAL)), {
    window: { durationMins: 300, usedPercent: 100, resetsAt: 1793333400_000 },
    observedAt: Date.parse("2026-10-30T03:31:47.112Z"),
  });
});

test("weekly and model-scoped weekly limits", () => {
  const weekly = structuredClone(REFUSAL);
  weekly.apiErrorParams.rate_limit_info.rateLimitType = "seven_day_opus";
  assert.deepEqual(parseTranscriptLimitLine(JSON.stringify(weekly))?.window, { durationMins: 10080, limitId: "seven_day_opus", usedPercent: 100, resetsAt: 1793333400_000 });
});

test("anything else is null: other lines, an allowed status, an unknown window, missing fields", () => {
  assert.equal(parseTranscriptLimitLine(JSON.stringify({ type: "user", message: { content: "apiErrorParams" } })), null);
  assert.equal(parseTranscriptLimitLine('{"apiErrorParams": '), null);
  for (const change of [
    (info: Record<string, unknown>) => (info.status = "allowed"),
    (info: Record<string, unknown>) => (info.rateLimitType = "one_minute"),
    (info: Record<string, unknown>) => delete info.resetsAt,
  ]) {
    const entry = structuredClone(REFUSAL);
    change(entry.apiErrorParams.rate_limit_info);
    assert.equal(parseTranscriptLimitLine(JSON.stringify(entry)), null);
  }
  const undated = structuredClone(REFUSAL) as Partial<typeof REFUSAL>;
  delete undated.timestamp;
  assert.equal(parseTranscriptLimitLine(JSON.stringify(undated)), null);
});

test("nothing of the conversation comes out", () => {
  const serialized = JSON.stringify(parseTranscriptLimitLine(JSON.stringify(REFUSAL)));
  for (const leaked of ["session limit", "req_redacted", "00000000-0000"]) assert.ok(!serialized.includes(leaked), leaked);
});
