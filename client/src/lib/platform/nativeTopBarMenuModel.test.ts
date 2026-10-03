import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n";
import type { ModelCatalog } from "@/lib/relay/relay-types";
import { buildTopBarMenuPayload } from "./nativeTopBarMenuModel";
import fixture from "../../../src-tauri/plugins/tauri-plugin-native-chrome/tests/fixtures/top_bar_menu_payload.json";

const en = getDictionary("en");
const catalog: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 4.1" },
    { id: "sonnet", label: "Sonnet 4.5" },
  ],
  defaultId: "opus",
};

const build = (over: Partial<Parameters<typeof buildTopBarMenuPayload>[0]> = {}) =>
  buildTopBarMenuPayload({ catalog, model: null, locked: false, connected: true, dict: en, ...over });

describe("buildTopBarMenuPayload", () => {
  it("is null without a catalog", () => {
    expect(build({ catalog: null })).toEqual({ model: null });
    expect(build({ catalog: { options: [] } })).toEqual({ model: null });
  });

  it("falls back to the catalog default when no model is picked", () => {
    expect(build().model?.currentId).toBe("opus");
    expect(build({ model: "sonnet" }).model?.currentLabel).toBe("Sonnet 4.5");
  });

  it("is disabled once locked, carrying the hint", () => {
    const { model } = build({ locked: true });
    expect(model?.enabled).toBe(false);
    expect(model?.locked).toBe(true);
    expect(model?.lockedHint).toBe(en.chat.composer.modelLocked);
  });

  it("is disabled while disconnected", () => {
    expect(build({ connected: false }).model?.enabled).toBe(false);
  });

  it("is disabled with no resolvable model", () => {
    const { model } = build({ catalog: { options: catalog.options } });
    expect(model?.enabled).toBe(false);
    expect(model?.currentLabel).toBe(en.chat.composer.pending);
  });

  it("matches the shared fixture the native side decodes", () => {
    const payload = build();
    expect(payload.model).toMatchObject({ currentId: "opus", enabled: true, locked: false });
    expect({ model: { ...payload.model, lockedHint: en.chat.composer.modelLocked } }).toEqual({
      model: { ...fixture.model, lockedHint: en.chat.composer.modelLocked },
    });
  });
});
