import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `client/src/lib/integrations/model.ts` mirrors
 * `relay/src/integrations/types.ts` — no shared package between the two npm
 * projects, so the integrations contract is duplicated, and a field that
 * drifted would compile on both sides and fail only at runtime. Same
 * reasoning as planUsageModelParity.test.ts. Only the header comment may
 * differ, since each copy names the other.
 */
function body(path: string): string {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
  const start = text.indexOf("\nexport ");
  expect(start, `${path} must export something`).toBeGreaterThan(-1);
  return text.slice(start);
}

describe("the integrations contract", () => {
  it("is identical on both sides", () => {
    expect(body("src/lib/integrations/model.ts")).toBe(body("../relay/src/integrations/types.ts"));
  });

  it("has each copy point at the other", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/integrations/model.ts"), "utf8")).toContain("relay/src/integrations/types.ts");
    expect(readFileSync(resolve(process.cwd(), "../relay/src/integrations/types.ts"), "utf8")).toContain("client/src/lib/integrations/model.ts");
  });
});
