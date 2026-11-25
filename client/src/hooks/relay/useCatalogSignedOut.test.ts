import { describe, expect, it } from "vitest";
import type { AgentInfo, AgentsCatalog } from "@/lib/install/agentsCatalog";
import { catalogSaysSignedOut } from "./useCatalogSignedOut";

const agent = (id: string, loggedIn: boolean | null): AgentInfo => ({
  id,
  bin: id,
  installed: true,
  version: null,
  loggedIn,
  account: null,
  plan: null,
  signIn: true,
  signOut: true,
  installUrl: null,
  docsUrl: null,
});
const catalog = (...agents: AgentInfo[]): AgentsCatalog => ({ agents, full: true });

describe("catalogSaysSignedOut", () => {
  it("is true only when the relay lists the agent with no login", () => {
    expect(catalogSaysSignedOut(catalog(agent("claude", false), agent("codex", true)), "claude")).toBe(true);
    expect(catalogSaysSignedOut(catalog(agent("claude", false), agent("codex", true)), "codex")).toBe(false);
  });

  it("says nothing for a login it couldn't read (an older relay) or an agent it doesn't list", () => {
    expect(catalogSaysSignedOut(catalog(agent("claude", null)), "claude")).toBe(false);
    expect(catalogSaysSignedOut(catalog(agent("codex", false)), "claude")).toBe(false);
  });
});
