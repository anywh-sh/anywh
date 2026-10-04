import { describe, expect, it } from "vitest";
import { filterSlashCommands, parseSlashCommand, suggestSlashCommand } from "./slashCommands";
import { en } from "@/i18n/en";
import type { ModelCatalog } from "@/lib/relay/relay-types";

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

const CLAUDE_CATALOG: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 5.5", description: "For complex work" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
  ],
  defaultId: "opus",
};

const CODEX_CATALOG: ModelCatalog = { options: [{ id: "gpt-5.5", label: "GPT-5.5" }], defaultId: "gpt-5.5" };

describe("parseSlashCommand", () => {
  it("recognizes /model against the session's agent's own catalog, whichever agent", () => {
    expect(parseSlashCommand("/model opus", CLAUDE_CATALOG)).toEqual({ name: "model", model: "opus" });
    expect(parseSlashCommand("/model gpt-5.5", CODEX_CATALOG)).toEqual({ name: "model", model: "gpt-5.5" });
  });

  it("passes another agent's model through as plain text instead of switching to it", () => {
    expect(parseSlashCommand("/model opus", CODEX_CATALOG)).toBeNull();
    expect(parseSlashCommand("/model gpt-5.5", CLAUDE_CATALOG)).toBeNull();
  });

  it("matches case-insensitively and hands back the catalog's own id", () => {
    expect(parseSlashCommand("/model CLAUDE-OPUS-4-8", CLAUDE_CATALOG)).toEqual({ name: "model", model: "claude-opus-4-8" });
  });

  it("keeps /model default and /clear, with or without a catalog", () => {
    expect(parseSlashCommand("/model default", null)).toEqual({ name: "model", model: "default" });
    expect(parseSlashCommand("/clear", null)).toEqual({ name: "clear" });
    expect(parseSlashCommand("/model opus", null)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("offers one /model entry per catalog model, blurbed with the CLI's own name and description", () => {
    const entries = filterSlashCommands("model", en.chat.composer, CLAUDE_CATALOG);
    expect(entries).toEqual([
      { command: "/model default", description: en.chat.composer.commands.modelDefault },
      { command: "/model opus", description: "Opus 5.5 · For complex work" },
      { command: "/model claude-opus-4-8", description: "Opus 4.8" },
    ]);
  });

  it("finds a model by its display name, not only by its id", () => {
    expect(filterSlashCommands("gpt-5", en.chat.composer, CODEX_CATALOG).map((entry) => entry.command)).toEqual(["/model gpt-5.5"]);
    expect(filterSlashCommands("4.8", en.chat.composer, CLAUDE_CATALOG).map((entry) => entry.command)).toEqual(["/model claude-opus-4-8"]);
  });
});

const CLAUDE_EFFORTS = { levels: [{ id: "low" }, { id: "high" }, { id: "xhigh" }], offersDefault: true };
const CODEX_EFFORTS = { levels: [{ id: "low", description: "Fast responses" }, { id: "ultra" }], offersDefault: false };

describe("/effort", () => {
  it("parses a level the effective model lists, case-insensitively, with the CLI's own casing", () => {
    expect(parseSlashCommand("/effort XHigh", null, CLAUDE_EFFORTS)).toEqual({ name: "effort", effort: "xhigh" });
  });

  it("`default` clears the pick only where the CLI reports no default of its own", () => {
    expect(parseSlashCommand("/effort default", null, CLAUDE_EFFORTS)).toEqual({ name: "effort", effort: null });
    expect(parseSlashCommand("/effort default", null, CODEX_EFFORTS)).toBeNull();
  });

  it("an unknown level, or a model with no efforts, falls through like an unknown /model", () => {
    expect(parseSlashCommand("/effort turbo", null, CLAUDE_EFFORTS)).toBeNull();
    expect(parseSlashCommand("/effort high", null, null)).toBeNull();
    expect(parseSlashCommand("/effort high", null)).toBeNull();
  });

  it("is typo-corrected like the other commands", () => {
    expect(suggestSlashCommand("/efort high")).toBe("/effort high");
  });

  it("autocompletes one entry per level of the effective model, plus default only for Claude-like models", () => {
    const claude = filterSlashCommands("effort", en.chat.composer, null, CLAUDE_EFFORTS);
    expect(claude).toEqual([
      { command: "/effort default", description: en.chat.composer.commands.effortDefault },
      { command: "/effort low", description: "Low" },
      { command: "/effort high", description: "High" },
      { command: "/effort xhigh", description: "Extra high" },
    ]);
    expect(filterSlashCommands("effort", en.chat.composer, null, CODEX_EFFORTS)).toEqual([
      { command: "/effort low", description: "Low · Fast responses" },
      { command: "/effort ultra", description: "Ultra" },
    ]);
  });

  it("offers nothing when the model takes no effort", () => {
    expect(filterSlashCommands("effort", en.chat.composer, null, null)).toEqual([]);
  });
});
