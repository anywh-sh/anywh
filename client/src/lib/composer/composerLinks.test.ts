import { describe, expect, it } from "vitest";
import { trimComposerText } from "./composerLinks";

describe("trimComposerText", () => {
  it("keeps the first line's indentation while dropping blank edges", () => {
    expect(trimComposerText("\n  \n    indented\n  next\n\n  ")).toBe("    indented\n  next");
  });

  it("empties a text of only whitespace", () => {
    expect(trimComposerText(" \n\t\n  ")).toBe("");
  });
});
