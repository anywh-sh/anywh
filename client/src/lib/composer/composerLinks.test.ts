import { describe, expect, it } from "vitest";
import { serializeEditorContent, trimComposerText } from "./composerLinks";

describe("trimComposerText", () => {
  it("keeps the first line's indentation while dropping blank edges", () => {
    expect(trimComposerText("\n  \n    indented\n  next\n\n  ")).toBe("    indented\n  next");
  });

  it("empties a text of only whitespace", () => {
    expect(trimComposerText(" \n\t\n  ")).toBe("");
  });
});

describe("serializeEditorContent", () => {
  it("sends a # ticket as just its key", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "look at " },
            { type: "ticketChip", attrs: { provider: "jira", site: "cloud-1", key: "NGL-12", title: "Filter by date" } },
            { type: "text", text: " now" },
          ],
        },
      ],
    };
    expect(serializeEditorContent(doc)).toBe("look at NGL-12 now");
  });
});
