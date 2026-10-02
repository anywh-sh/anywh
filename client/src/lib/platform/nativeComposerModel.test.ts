import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";
import { buildComposerPayload, type ComposerModelInput } from "./nativeComposerModel";
import fixture from "../../../src-tauri/plugins/tauri-plugin-native-chrome/tests/fixtures/composer_payload.json";

const en = getDictionary("en");
const pt = getDictionary("pt-BR");

const theme: NativeShellTheme = {
  background: "#111111",
  sidebar: "#161616",
  elevated: "#1c1c1c",
  card: "#202020",
  foreground: "#eeeeee",
  muted: "#999999",
  faint: "#666666",
  border: "#2a2a2a",
  primary: "#e0642a",
  primaryForeground: "#ffffff",
  destructive: "#dc6f5c",
  tint: "#eceae4",
  success: "#e0642a",
};

const image = (path: string, previewUrl?: string): PendingAttachment => ({ kind: "image", path, previewUrl });
const video = (path: string, previewUrl?: string): PendingAttachment => ({ kind: "video", path, previewUrl });

function build(over: Partial<ComposerModelInput> = {}) {
  return buildComposerPayload({
    dict: en,
    theme,
    hidden: false,
    disabled: false,
    isEmpty: true,
    turnInFlight: false,
    uploading: false,
    pendingImages: [],
    editBannerText: null,
    typo: null,
    thumbnailFor: () => "data:image/jpeg;base64,AAAA",
    ...over,
  });
}

describe("buildComposerPayload", () => {
  describe("canSend", () => {
    it("is false for an empty field with nothing attached", () => {
      expect(build().canSend).toBe(false);
    });
    it("is true with text", () => {
      expect(build({ isEmpty: false }).canSend).toBe(true);
    });
    it("is true with only an attachment", () => {
      expect(build({ pendingImages: [image("/a.png")] }).canSend).toBe(true);
    });
    it("is false when disconnected, whatever is typed", () => {
      expect(build({ disabled: true, isEmpty: false, pendingImages: [image("/a.png")] }).canSend).toBe(false);
    });
    it("stays true with text while a turn is running", () => {
      const payload = build({ isEmpty: false, turnInFlight: true });
      expect(payload.canSend).toBe(true);
      expect(payload.turnInFlight).toBe(true);
    });
  });

  it("disables attaching while an upload runs", () => {
    expect(build({ uploading: true })).toMatchObject({ attachEnabled: false, uploading: true });
    expect(build()).toMatchObject({ attachEnabled: true, uploading: false });
  });

  it("passes hidden through", () => {
    expect(build({ hidden: true }).hidden).toBe(true);
  });

  describe("attachments", () => {
    it("carries the thumbnail when there is a preview", () => {
      const [first] = build({ pendingImages: [image("/uploads/a.png", "blob:x")] }).attachments;
      expect(first).toEqual({ path: "/uploads/a.png", kind: "image", thumbnail: "data:image/jpeg;base64,AAAA", name: "a.png" });
    });

    it("has no thumbnail without a preview, so the native side draws a name chip", () => {
      const [first] = build({ pendingImages: [video("/uploads/b.mov")] }).attachments;
      expect(first).toEqual({ path: "/uploads/b.mov", kind: "video", thumbnail: null, name: "b.mov" });
    });

    it("has no thumbnail while the preview hasn't been resized yet", () => {
      const [first] = build({ pendingImages: [image("/a.png", "blob:x")], thumbnailFor: () => null }).attachments;
      expect(first.thumbnail).toBeNull();
    });

    it("names a path with no basename with the unnamed-attachment copy", () => {
      expect(build({ pendingImages: [image("/")] }).attachments[0].name).toBe(en.chat.composer.unnamedAttachment);
    });
  });

  describe("banners", () => {
    it("builds the edit banner with the localized cancel label", () => {
      expect(build({ editBannerText: "Editing" }).editBanner).toEqual({ text: "Editing", cancelLabel: en.chat.message.cancelEdit });
      expect(build().editBanner).toBeNull();
    });

    it("splits the typo question around the command", () => {
      expect(build({ typo: { suggestion: "/clear" } }).typo).toEqual({
        before: "Unknown command — did you mean ",
        command: "/clear",
        after: "?",
        useLabel: en.chat.composer.typo.use,
        sendAnywayLabel: en.chat.composer.typo.sendAnyway,
      });
    });

    it("handles the command at the start or the end of the sentence", () => {
      const at = (question: string) => {
        const dict = { ...en, chat: { ...en.chat, composer: { ...en.chat.composer, typo: { ...en.chat.composer.typo, question } } } };
        return build({ dict, typo: { suggestion: "/clear" } }).typo!;
      };
      expect(at("{command} is not a command")).toMatchObject({ before: "", after: " is not a command" });
      expect(at("Did you mean {command}")).toMatchObject({ before: "Did you mean ", after: "" });
      expect(at("No placeholder here")).toMatchObject({ before: "No placeholder here", after: "" });
    });
  });

  it("takes every string from the dictionary, in both languages", () => {
    expect(build().strings).toMatchObject({ send: en.common.send, stop: en.common.stop, attachPhotos: en.chat.composer.attachPhotos });
    expect(build({ dict: pt }).strings).toMatchObject({ send: pt.common.send, scrollToEnd: pt.chat.composer.scrollToEnd });
    expect(build({ dict: pt }).placeholder).toBe(pt.chat.composer.placeholder);
  });

  it("produces exactly the JSON the Rust side deserializes (shared fixture)", () => {
    const payload = build({
      isEmpty: false,
      pendingImages: [image("/uploads/a.png", "blob:x"), video("/uploads/b.mov")],
      editBannerText: en.chat.message.editWarning,
      typo: { suggestion: "/clear" },
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(fixture);
  });
});
