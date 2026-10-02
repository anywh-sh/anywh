import { describe, expect, it } from "vitest";
import { activeModelLabel } from "./modelCatalog";
import type { ModelCatalog } from "@/lib/relay/relay-types";

const catalog = { defaultId: "opus", options: [{ id: "opus", label: "Opus 4" }, { id: "sonnet", label: "Sonnet 4" }] } as unknown as ModelCatalog;

describe("activeModelLabel", () => {
  it("uses the explicit pick when there is one", () => {
    expect(activeModelLabel(catalog, "sonnet")).toBe("Sonnet 4");
  });
  it("falls back to the catalog default", () => {
    expect(activeModelLabel(catalog, null)).toBe("Opus 4");
  });
  it("is null while nothing is known", () => {
    expect(activeModelLabel(null, null)).toBeNull();
  });
  it("falls back to the raw id when the catalog is missing", () => {
    expect(activeModelLabel(null, "sonnet")).toBe("sonnet");
  });
});
