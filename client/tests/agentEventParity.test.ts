import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `client/src/lib/relay/agent-event.ts` and `relay/src/protocol/agent-event.ts`
 * are the same contract, duplicated because there's no shared package
 * between the two npm projects in this repo. Both sides have to agree on
 * the exact same vocabulary: the relay is the only one that produces an
 * `AgentEvent`, and the client is the only one that renders it — a type
 * that drifted between the two would compile fine on both sides and fail
 * only at runtime, as a render for a shape that doesn't exist.
 *
 * "Keep them in sync" living only in a comment would be a silent,
 * one-directional failure — same reasoning as themeValidatorParity.test.ts
 * and protocolVersionParity.test.ts, which this mirrors.
 *
 * Only the header comment may differ, since each copy names the other.
 */
// Resolved from the runner's cwd (always `client/`, where vitest.config.ts
// lives) — same reasoning as themeValidatorParity.test.ts's read of theme.ts.
function body(path: string): string {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  const start = text.indexOf("\nexport ");
  expect(start, `${path} must export something`).toBeGreaterThan(-1);
  return text.slice(start);
}

describe("the AgentEvent contract", () => {
  it("is identical on both sides", () => {
    expect(body("src/lib/relay/agent-event.ts")).toBe(body("../relay/src/protocol/agent-event.ts"));
  });

  it("has each copy point at the other", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/relay/agent-event.ts"), "utf8")).toContain(
      "relay/src/protocol/agent-event.ts",
    );
    expect(readFileSync(resolve(process.cwd(), "../relay/src/protocol/agent-event.ts"), "utf8")).toContain(
      "client/src/lib/relay/agent-event.ts",
    );
  });
});
