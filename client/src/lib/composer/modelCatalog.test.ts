import { describe, expect, it } from "vitest";
import { catalogsFromLegacyDefaultModelState, splitModelOptions } from "./modelCatalog";

// The message verbatim from a relay built before per-agent catalogs — what
// the production relay was still sending when a client updated ahead of it
// hid the picker altogether.
const LEGACY_AVAILABLE = ["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan", "default"];

describe("catalogsFromLegacyDefaultModelState", () => {
  it("turns an old relay's aliases into Claude's catalog, so the picker still shows", () => {
    const { claude } = catalogsFromLegacyDefaultModelState("Opus", LEGACY_AVAILABLE);

    expect(claude.options.map((option) => option.id)).toEqual(LEGACY_AVAILABLE.filter((alias) => alias !== "default"));
    expect(claude.defaultId).toBe("opus");
  });

  it("shows each alias as the id it is — that relay never sent a display name", () => {
    const { claude } = catalogsFromLegacyDefaultModelState("Opus", ["opus[1m]"]);

    expect(claude.options).toEqual([{ id: "opus[1m]", label: "opus[1m]" }]);
  });

  it("leaves defaultId out when the family name matches no alias, instead of guessing", () => {
    expect(catalogsFromLegacyDefaultModelState("Opus 5.5", ["opus", "sonnet"]).claude.defaultId).toBeUndefined();
  });

  it("yields no catalog at all for an empty alias list", () => {
    expect(catalogsFromLegacyDefaultModelState("Opus", ["default"])).toEqual({});
  });
});

describe("splitModelOptions", () => {
  const opus = { id: "opus", label: "Opus 5.5" };
  const pinned = { id: "claude-opus-4-8", label: "Opus 4.8", pinnedVersion: true as const };

  it("puts pinned versions under More models, in the CLI's order", () => {
    expect(splitModelOptions({ options: [opus, pinned] })).toEqual({ primary: [opus], more: [pinned] });
  });

  it("keeps everything at the top level when nothing is pinned (every other agent, an older relay)", () => {
    const gpt = { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" };
    expect(splitModelOptions({ options: [gpt] })).toEqual({ primary: [gpt], more: [] });
  });

  it("never leaves the top level empty when everything is pinned", () => {
    expect(splitModelOptions({ options: [pinned] })).toEqual({ primary: [pinned], more: [] });
  });

  it("is empty without a catalog", () => {
    expect(splitModelOptions(null)).toEqual({ primary: [], more: [] });
  });
});
