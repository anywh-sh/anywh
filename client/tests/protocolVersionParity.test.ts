import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `client/src/lib/relay/protocolVersion.ts` and `relay/src/protocol/version.ts`
 * are the same constant, duplicated because there's no shared package
 * between the two npm projects in this repo. Both sides have to agree on
 * the exact same integer: the relay announces it on every WebSocket
 * connection, and the client compares it to know whether it can safely
 * understand what the relay is about to send.
 *
 * "Keep them in sync" living only in a comment would be a silent,
 * one-directional failure — the relay bumps it for a real wire vocabulary
 * change and the client copy quietly stays behind, so a mismatch that
 * exists goes unreported instead of surfacing as "update the app".
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

describe("the WS protocol version", () => {
  it("is identical on both sides", () => {
    expect(body("src/lib/relay/protocolVersion.ts")).toBe(body("../relay/src/protocol/version.ts"));
  });

  it("has each copy point at the other", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/relay/protocolVersion.ts"), "utf8")).toContain(
      "relay/src/protocol/version.ts",
    );
    expect(readFileSync(resolve(process.cwd(), "../relay/src/protocol/version.ts"), "utf8")).toContain(
      "client/src/lib/relay/protocolVersion.ts",
    );
  });
});
