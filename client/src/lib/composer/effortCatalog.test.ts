import { describe, expect, it } from "vitest";
import { effectiveEffort, effectiveModelOption, effortsFor, labelForEffort, modelAcceptsEffort } from "./effortCatalog";
import { en } from "@/i18n/en";
import type { ModelCatalog } from "@/lib/relay/relay-types";

const CATALOG: ModelCatalog = {
  options: [
    { id: "a", label: "A", efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "low" },
    { id: "b", label: "B" },
  ],
  defaultId: "a",
};

describe("effortCatalog", () => {
  it("resolves the effective model's entry from the pick, else the catalog default", () => {
    expect(effectiveModelOption(CATALOG, null)?.id).toBe("a");
    expect(effectiveModelOption(CATALOG, "b")?.id).toBe("b");
    expect(effectiveModelOption(CATALOG, "unknown")).toBeNull();
    expect(effectiveModelOption(null, null)).toBeNull();
  });

  it("lists no efforts for a model without any", () => {
    expect(effortsFor(CATALOG, null).map((e) => e.id)).toEqual(["low", "high"]);
    expect(effortsFor(CATALOG, "b")).toEqual([]);
    expect(effortsFor(null, null)).toEqual([]);
  });

  it("effectiveEffort: the pick, else the model's default, else null", () => {
    const option = CATALOG.options[0];
    expect(effectiveEffort(option, "high")).toBe("high");
    expect(effectiveEffort(option, null)).toBe("low");
    expect(effectiveEffort({ id: "x", label: "X", efforts: [{ id: "low" }] }, null)).toBeNull();
    expect(effectiveEffort(null, null)).toBeNull();
  });

  it("modelAcceptsEffort follows the effective model", () => {
    expect(modelAcceptsEffort(CATALOG, null, "high")).toBe(true);
    expect(modelAcceptsEffort(CATALOG, "b", "high")).toBe(false);
    expect(modelAcceptsEffort(CATALOG, null, "ultra")).toBe(false);
  });

  it("labelForEffort: dictionary label for a known id, the raw id otherwise", () => {
    expect(labelForEffort(en.chat.composer.effortLabels, "xhigh")).toBe("Extra high");
    expect(labelForEffort(en.chat.composer.effortLabels, "turbo")).toBe("turbo");
  });
});
