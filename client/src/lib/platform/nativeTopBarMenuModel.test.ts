import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n";
import type { ModelCatalog, PermissionModeOption } from "@/lib/relay/relay-types";
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

const permissionModes: PermissionModeOption[] = [
  { id: "default", pausesForApproval: true },
  { id: "plan", pausesForApproval: true },
];

const build = (over: Partial<Parameters<typeof buildTopBarMenuPayload>[0]> = {}) =>
  buildTopBarMenuPayload({ catalog, model: null, locked: false, connected: true, permissionMode: "plan", permissionModes, dict: en, ...over });

describe("buildTopBarMenuPayload", () => {
  it("is null without a catalog", () => {
    expect(build({ catalog: null }).model).toBeNull();
    expect(build({ catalog: { options: [] } }).model).toBeNull();
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

  it("offers the session's permission modes with their copy", () => {
    const { mode } = build();
    expect(mode?.currentId).toBe("plan");
    expect(mode?.currentLabel).toBe(en.chat.composer.mode.plan.label);
    expect(mode?.options).toEqual([
      { id: "default", ...en.chat.composer.mode.default },
      { id: "plan", ...en.chat.composer.mode.plan },
    ]);
    expect(mode?.enabled).toBe(true);
  });

  it("has no mode entry before the relay reports the modes", () => {
    expect(build({ permissionModes: [], permissionMode: null }).mode).toBeNull();
  });

  it("disables the mode entry while disconnected or before a mode is known", () => {
    expect(build({ connected: false }).mode?.enabled).toBe(false);
    const { mode } = build({ permissionMode: null });
    expect(mode?.enabled).toBe(false);
    expect(mode?.currentLabel).toBe(en.chat.composer.pending);
  });

  it("matches the shared fixture the native side decodes", () => {
    const payload = build({ permissionMode: "default" });
    expect(payload.model).toMatchObject({ currentId: "opus", enabled: true, locked: false });
    expect({ ...payload, model: { ...payload.model, lockedHint: en.chat.composer.modelLocked } }).toEqual({
      ...fixture,
      model: { ...fixture.model, lockedHint: en.chat.composer.modelLocked },
    });
  });
});
