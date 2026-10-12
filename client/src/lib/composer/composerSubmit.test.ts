import { describe, expect, it } from "vitest";
import { decideSubmit } from "./composerSubmit";
import type { ModelCatalog } from "@/lib/relay/relay-types";

const CATALOG: ModelCatalog = { options: [{ id: "opus", label: "Opus" }], defaultId: "opus" };

function decide(text: string, overrides: Partial<Parameters<typeof decideSubmit>[0]> = {}) {
  return decideSubmit({ text, attachmentCount: 0, uploading: false, confirmedTypoText: null, catalog: CATALOG, ...overrides });
}

describe("decideSubmit", () => {
  it("does nothing for empty text without attachments", () => {
    expect(decide("")).toEqual({ kind: "empty" });
  });

  it("sends an attachment-only message", () => {
    expect(decide("", { attachmentCount: 1 })).toEqual({ kind: "send" });
  });

  it("holds the send while an attachment is still uploading", () => {
    expect(decide("look at this", { uploading: true })).toEqual({ kind: "uploading" });
    expect(decide("", { attachmentCount: 1, uploading: true })).toEqual({ kind: "uploading" });
    // Nothing typed and nothing attached yet — the first file is the one in flight.
    expect(decide("", { uploading: true })).toEqual({ kind: "uploading" });
  });

  it("sends plain text", () => {
    expect(decide("hello there")).toEqual({ kind: "send" });
  });

  it("sends a valid command", () => {
    expect(decide("/clear")).toEqual({ kind: "send" });
    expect(decide("/model opus")).toEqual({ kind: "send" });
  });

  it("blocks a new typo-shaped command with the suggestion", () => {
    expect(decide("/cler")).toEqual({ kind: "typo", suggestion: "/clear" });
  });

  it("sends once the same typo text is reconfirmed", () => {
    expect(decide("/cler", { confirmedTypoText: "/cler" })).toEqual({ kind: "send" });
  });

  it("blocks again when the text changed since the banner was shown", () => {
    expect(decide("/modle opus", { confirmedTypoText: "/cler" })).toEqual({ kind: "typo", suggestion: "/model opus" });
  });

  it("sends text that merely starts with a slash and has no suggestion", () => {
    expect(decide("/etc/passwd")).toEqual({ kind: "send" });
  });
});
