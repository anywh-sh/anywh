import { describe, expect, it } from "vitest";
import { suggestSlashCommand } from "./slashCommands";

describe("suggestSlashCommand", () => {
  it("suggests /clear for a single missing letter", () => {
    expect(suggestSlashCommand("/cler")).toBe("/clear");
  });

  it("suggests /model for a transposition typo, keeping the argument", () => {
    expect(suggestSlashCommand("/modle opus")).toBe("/model opus");
  });

  it("returns null for an already-valid command (parseSlashCommand's job, not this one)", () => {
    expect(suggestSlashCommand("/clear")).toBeNull();
    expect(suggestSlashCommand("/model opus")).toBeNull();
  });

  it("returns null for plain text that merely starts a line with a slash", () => {
    expect(suggestSlashCommand("/home/wil/anywh/CLAUDE.md please read this")).toBeNull();
    expect(suggestSlashCommand("/etc/passwd")).toBeNull();
  });

  it("returns null for text that doesn't start with a slash", () => {
    expect(suggestSlashCommand("clear the terminal please")).toBeNull();
  });

  it("returns null for just a bare slash", () => {
    expect(suggestSlashCommand("/")).toBeNull();
  });

  it("returns null when the typed word is too far from any known keyword", () => {
    expect(suggestSlashCommand("/close")).toBeNull();
  });
});
