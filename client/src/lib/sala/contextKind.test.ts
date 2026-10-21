import { describe, expect, it } from "vitest";
import { contextKindLabel } from "@/lib/sala/contextKind";

describe("contextKindLabel", () => {
  it("names a PDF and an image by their kind whatever the file is called", () => {
    expect(contextKindLabel({ name: "spec", kind: "pdf" })).toBe("PDF");
    expect(contextKindLabel({ name: "shot.PNG", kind: "image" })).toBe("IMG");
  });

  it("uses the extension of a text file, upper-cased", () => {
    expect(contextKindLabel({ name: "perfil-briefing.md", kind: "text" })).toBe("MD");
    expect(contextKindLabel({ name: "api.test.ts", kind: "text" })).toBe("TS");
  });

  it("falls back to the kind when there is no usable extension", () => {
    expect(contextKindLabel({ name: "Makefile", kind: "text" })).toBe("TXT");
    expect(contextKindLabel({ name: ".env", kind: "text" })).toBe("TXT");
    expect(contextKindLabel({ name: "archive.tar-gz-long", kind: "binary" })).toBe("BIN");
    expect(contextKindLabel({ name: "blob", kind: "binary" })).toBe("BIN");
  });
});
