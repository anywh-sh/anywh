import { describe, expect, it } from "vitest";
import { isLargePaste, LARGE_PASTE_MIN_CHARS, LARGE_PASTE_MIN_LINES, pastedTextName } from "@/lib/composer/largePaste";

describe("isLargePaste", () => {
  it("stays inline just under both bounds", () => {
    expect(isLargePaste("x".repeat(LARGE_PASTE_MIN_CHARS - 1))).toBe(false);
    expect(isLargePaste(Array.from({ length: LARGE_PASTE_MIN_LINES - 1 }, () => "a").join("\n"))).toBe(false);
  });

  it("turns into an attachment at either bound", () => {
    expect(isLargePaste("x".repeat(LARGE_PASTE_MIN_CHARS))).toBe(true);
    expect(isLargePaste(Array.from({ length: LARGE_PASTE_MIN_LINES }, () => "a").join("\n"))).toBe(true);
  });
});

describe("pastedTextName", () => {
  it("names the file after the first line with text", () => {
    expect(pastedTextName("# Deploy checklist\n\n- step one")).toBe("deploy-checklist.txt");
    expect(pastedTextName("\n\n  Fix the login redirect!  \nmore")).toBe("fix-the-login-redirect.txt");
  });

  it("keeps letters and digits of any script", () => {
    expect(pastedTextName("Instruções de implantação v2")).toBe("instruções-de-implantação-v2.txt");
  });

  it("caps the length without leaving a trailing dash", () => {
    const name = pastedTextName("word ".repeat(40));
    expect(name.length).toBeLessThanOrEqual(40 + ".txt".length);
    expect(name).not.toMatch(/-\.txt$/);
    // Cut between words, not inside one.
    expect(pastedTextName("Follow these instructions carefully and then continue")).toBe("follow-these-instructions-carefully-and.txt");
    // One long unbroken word has no boundary to cut at.
    expect(pastedTextName("x".repeat(100))).toBe(`${"x".repeat(40)}.txt`);
  });

  it("falls back when no line has text", () => {
    expect(pastedTextName("--- \n *** \n")).toBe("pasted-text.txt");
    expect(pastedTextName("")).toBe("pasted-text.txt");
  });

  it("keeps two pastes of one message apart", () => {
    expect(pastedTextName("Notes\nA", ["notes.txt"])).toBe("notes-2.txt");
    expect(pastedTextName("Notes\nA", ["notes.txt", "notes-2.txt"])).toBe("notes-3.txt");
  });
});
