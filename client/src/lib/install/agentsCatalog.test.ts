import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCardState,
  fetchAgentsCatalog,
  preselectedAgent,
  type AgentInfo,
} from "@/lib/install/agentsCatalog";
import type { Profile } from "@/lib/profiles/profiles";

const profile: Profile = {
  id: "default",
  label: "Personal",
  host: "127.0.0.1",
  relayPort: 8765,
};

function agent(over: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    bin: over.id,
    installed: true,
    version: "1.0.0",
    loggedIn: true,
    loginCommand: null,
    installUrl: null,
    ...over,
  };
}

function respond(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agentCardState", () => {
  it("maps a missing CLI, a missing login and a ready one", () => {
    expect(
      agentCardState(
        agent({ id: "codex", installed: false, version: null, loggedIn: null }),
      ),
    ).toBe("missing");
    expect(agentCardState(agent({ id: "codex", loggedIn: false }))).toBe(
      "noLogin",
    );
    expect(agentCardState(agent({ id: "claude" }))).toBe("ready");
  });

  it("treats an agent with no probeable login as ready", () => {
    expect(agentCardState(agent({ id: "x", loggedIn: null }))).toBe("ready");
  });
});

describe("preselectedAgent", () => {
  it("prefers the first ready agent, then the first installed one", () => {
    const noLoginClaude = agent({ id: "claude", loggedIn: false });
    const readyCodex = agent({ id: "codex" });
    expect(preselectedAgent([noLoginClaude, readyCodex])?.id).toBe("codex");
    expect(
      preselectedAgent([
        noLoginClaude,
        agent({ id: "codex", installed: false, loggedIn: null }),
      ])?.id,
    ).toBe("claude");
  });

  it("is null when nothing is installed", () => {
    expect(
      preselectedAgent([
        agent({ id: "claude", installed: false, loggedIn: null }),
      ]),
    ).toBeNull();
    expect(preselectedAgent([])).toBeNull();
  });
});

describe("fetchAgentsCatalog", () => {
  it("reads /control/agents", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        respond(200, {
          agents: [
            {
              id: "claude",
              bin: "claude",
              installed: true,
              version: "2.1.0",
              loggedIn: true,
              loginCommand: "claude auth login",
              installUrl: "https://x",
            },
            {
              id: "codex",
              bin: "codex",
              installed: false,
              version: null,
              loggedIn: null,
              loginCommand: "codex login",
              installUrl: "https://y",
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const catalog = await fetchAgentsCatalog(profile);
    expect(catalog.full).toBe(true);
    expect(catalog.agents.map((a) => [a.id, agentCardState(a)])).toEqual([
      ["claude", "ready"],
      ["codex", "missing"],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/control/agents",
      expect.anything(),
    );
  });

  it.each([404, 426])(
    "falls back to /host-info when an older relay answers %i",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.endsWith("/control/agents"))
            return Promise.resolve(respond(status));
          return Promise.resolve(
            respond(200, {
              hostname: "box",
              platform: "linux",
              editor: null,
              agents: [{ id: "claude", capabilities: {}, version: "2.0.1" }],
            }),
          );
        }),
      );
      const catalog = await fetchAgentsCatalog(profile);
      expect(catalog.full).toBe(false);
      expect(catalog.agents).toEqual([
        {
          id: "claude",
          bin: "claude",
          installed: true,
          version: "2.0.1",
          loggedIn: null,
          loginCommand: null,
          installUrl: null,
        },
      ]);
    },
  );

  it("falls back to /host-info when the route's answer can't be read (an older relay's 426 has no CORS header)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/control/agents")) return Promise.reject(new TypeError("Load failed"));
        return Promise.resolve(respond(200, { hostname: "box", platform: "linux", editor: null, agents: [{ id: "codex", capabilities: {} }] }));
      }),
    );
    const catalog = await fetchAgentsCatalog(profile);
    expect(catalog.full).toBe(false);
    expect(catalog.agents.map((a) => a.id)).toEqual(["codex"]);
  });

  it("keeps the original error when /host-info can't be read either", async () => {
    const original = new TypeError("Load failed");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (url.endsWith("/control/agents") ? Promise.reject(original) : Promise.reject(new TypeError("other")))),
    );
    await expect(fetchAgentsCatalog(profile)).rejects.toBe(original);
  });

  it("rejects on any other failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(500))),
    );
    await expect(fetchAgentsCatalog(profile)).rejects.toThrow("HTTP 500");
  });
});
