import { describe, expect, it } from "vitest";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import { buildWireMessage, parseWireMessage } from "@/lib/composer/wireMessage";

const image: PendingAttachment = { kind: "image", path: "/tmp/anywh-uploads/a1.png", previewUrl: "blob:local" };
const video: PendingAttachment = {
  kind: "video",
  path: "/tmp/anywh-uploads/v1.mov",
  frames: ["/tmp/anywh-uploads/v1-frame-1.jpg", "/tmp/anywh-uploads/v1-frame-2.jpg"],
};
const videoWithoutFrames: PendingAttachment = { kind: "video", path: "/tmp/anywh-uploads/v2.webm" };
const named: PendingAttachment = { kind: "file", path: "/tmp/anywh-uploads/f1.md", name: "notes (draft).md" };
const unnamed: PendingAttachment = { kind: "file", path: "/tmp/anywh-uploads/f2.pdf" };

/** What the relay hands back has no local preview: that was the sender's
 * own object URL. */
function withoutPreview(attachment: PendingAttachment): PendingAttachment {
  const { previewUrl: _previewUrl, ...rest } = attachment;
  return rest;
}

describe("parseWireMessage", () => {
  it("gives back the typed text and every attachment buildWireMessage wrote", () => {
    const attachments = [image, video, videoWithoutFrames, unnamed];
    const parsed = parseWireMessage(buildWireMessage("look at these\nplease", attachments));
    expect(parsed.text).toBe("look at these\nplease");
    expect(parsed.attachments).toEqual(attachments.map(withoutPreview));
  });

  it("keeps a sent file's name, with the characters the wire format replaced", () => {
    const parsed = parseWireMessage(buildWireMessage("", [named]));
    expect(parsed.attachments).toEqual([{ kind: "file", path: named.path, name: "notes _draft_.md" }]);
  });

  it("reads a message that is only attachments", () => {
    const parsed = parseWireMessage(buildWireMessage("", [image]));
    expect(parsed).toEqual({ text: "", attachments: [withoutPreview(image)] });
  });

  it("leaves a message without markers alone", () => {
    expect(parseWireMessage("just text\n\nand more")).toEqual({ text: "just text\n\nand more", attachments: [] });
  });

  it("leaves a marker the person typed in the middle of their text alone", () => {
    const typed = "I wrote [imagem anexada: /tmp/x.png]\nmyself";
    expect(parseWireMessage(typed)).toEqual({ text: typed, attachments: [] });
  });

  it("leaves a trailing marker not set off by a blank line alone", () => {
    const typed = "see below\n[imagem anexada: /tmp/x.png]";
    expect(parseWireMessage(typed)).toEqual({ text: typed, attachments: [] });
  });
});
