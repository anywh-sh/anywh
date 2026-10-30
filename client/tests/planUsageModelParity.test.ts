import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `client/src/lib/planUsage/model.ts` mirrors `relay/src/planUsage/types.ts`
 * — no shared package between the two npm projects, so the plan usage
 * contract is duplicated, and a field that drifted would compile on both
 * sides and fail only at runtime. Same reasoning as agentEventParity.test.ts.
 * Only the header comment may differ, since each copy names the other.
 */
function body(path: string): string {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  const start = text.indexOf("\nexport ");
  expect(start, `${path} must export something`).toBeGreaterThan(-1);
  return text.slice(start);
}

describe("the plan usage contract", () => {
  it("is identical on both sides", () => {
    expect(body("src/lib/planUsage/model.ts")).toBe(body("../relay/src/planUsage/types.ts"));
  });

  it("has each copy point at the other", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/planUsage/model.ts"), "utf8")).toContain(
      "relay/src/planUsage/types.ts",
    );
    expect(readFileSync(resolve(process.cwd(), "../relay/src/planUsage/types.ts"), "utf8")).toContain(
      "client/src/lib/planUsage/model.ts",
    );
  });
});
