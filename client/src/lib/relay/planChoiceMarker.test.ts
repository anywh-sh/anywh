import { describe, expect, it } from "vitest";
import { stripPlanChoiceMarkers } from "./planChoiceMarker";

describe("stripPlanChoiceMarkers", () => {
  it("leaves ordinary text untouched", () => {
    expect(stripPlanChoiceMarkers("Here's the plan, step by step.")).toBe("Here's the plan, step by step.");
  });

  it("strips a complete >>>QUESTION:...>>>END block, trimming the trailing whitespace it leaves behind", () => {
    const text = "Before.\n\n>>>QUESTION: Which approach?\n- A\n- B\n>>>END\n\nAfter.";
    // The relay renders the parsed block as its own ChoiceCard (see
    // relay/src/planChoiceMarker.ts) — this strips the raw sentinel out of
    // the displayed message text so the human doesn't see it twice.
    expect(stripPlanChoiceMarkers(text)).toBe("Before.\n\nAfter.");
  });

  it("strips multiple complete blocks in one response", () => {
    const text = ">>>QUESTION: One?\n- Yes\n- No\n>>>END\nmiddle\n>>>QUESTION: Two?\n- Yes\n- No\n>>>END";
    expect(stripPlanChoiceMarkers(text)).toBe("middle");
  });

  it("strips a still-open block with no >>>END yet (mid-stream)", () => {
    // A still-streaming response can end mid-block — since streamed text
    // only ever grows, the open block is always at the tail of what's
    // arrived so far (see the function's own doc comment).
    const text = "Here's the plan.\n\n>>>QUESTION: Which approach?\n- A\n- ";
    expect(stripPlanChoiceMarkers(text)).toBe("Here's the plan.");
  });

  it("does not strip an >>>END token that never had a matching >>>QUESTION: before it", () => {
    const text = "Some text mentioning >>>END on its own.";
    expect(stripPlanChoiceMarkers(text)).toBe(text);
  });
});
