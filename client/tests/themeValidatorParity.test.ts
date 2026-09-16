import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `client/src/lib/theme.ts` and `relay/src/host/theme.ts` are the same validator,
 * duplicated because there's no shared package in this repo. Both sides have
 * to give the exact same answer about whether a theme file is broken: the
 * client validates to show a specific error without a round trip, and the
 * relay validates again because it writes the file to disk and can't trust a
 * body just because some client said it was fine.
 *
 * "Keep them in sync" lived only in a comment at the top of both files. The
 * failure that produces is quiet and one-directional — a rule tightened on
 * the client alone lets a file the client rejects get saved anyway by another
 * client, and a rule tightened on the relay alone makes a save fail with a
 * dialog that just showed no errors at all.
 *
 * Only the header comment may differ, since each copy names the other.
 */
// Resolved from the runner's cwd (always `client/`, where vitest.config.ts
// lives) — same reasoning as builtinThemes.test.ts's read of index.css.
function body(path: string): string {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  const start = text.indexOf("\nexport ");
  expect(start, `${path} must export something`).toBeGreaterThan(-1);
  return text.slice(start);
}

describe("the theme validator", () => {
  it("is identical on both sides", () => {
    expect(body("src/lib/theme.ts")).toBe(body("../relay/src/host/theme.ts"));
  });

  it("has each copy point at the other", () => {
    // The header is the one part allowed to differ, and it's the only place
    // the duplication is explained — a copy that lost it reads like a file
    // that can be edited on its own.
    expect(readFileSync(resolve(process.cwd(), "src/lib/theme.ts"), "utf8")).toContain("relay/src/host/theme.ts");
    expect(readFileSync(resolve(process.cwd(), "../relay/src/host/theme.ts"), "utf8")).toContain("client/src/lib/theme.ts");
  });
});
