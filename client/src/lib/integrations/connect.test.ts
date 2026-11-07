import { describe, expect, it } from "vitest";
import { checkCallbackPaste, connectProgress, connectRows, integrationForServer, pendingTargets } from "@/lib/integrations/connect";
import type { IntegrationRuntime, IntegrationState, McpAuthFlow } from "@/lib/integrations/model";

function runtime(patch: Partial<IntegrationRuntime>): IntegrationRuntime {
  return { runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0, ...patch };
}

function jira(runtimes: IntegrationRuntime[]): IntegrationState {
  return { id: "jira", provider: "jira", runtimes, prefs: { project: null }, queries: [] };
}

function flow(patch: Partial<McpAuthFlow> & Pick<McpAuthFlow, "flowId" | "phase">): McpAuthFlow {
  return { runtimeId: "claude", serverName: "atlassian", mode: "deeplink", ...patch };
}

describe("connectRows", () => {
  it("lists the agents with a server, then the installed ones without", () => {
    const rows = connectRows(jira([runtime({ status: "needs_auth" })]), {}, ["claude", "codex"]);
    expect(rows.map((row) => [row.runtimeId, row.state])).toEqual([
      ["claude", "needs_auth"],
      ["codex", "missing"],
    ]);
    // A machine that could not say lists only what it knows.
    expect(connectRows(jira([runtime({ status: "needs_auth" })]), {}, null)).toHaveLength(1);
  });

  it("shows the newest flow of each server; a finished one reads as connected, a cancelled one as nothing", () => {
    const integration = jira([runtime({ status: "needs_auth" })]);
    const flows = { a: flow({ flowId: "a", phase: "failed" }), b: flow({ flowId: "b", phase: "awaiting_user" }) };
    expect(connectRows(integration, flows, null)[0].flow?.flowId).toBe("b");
    expect(connectRows(integration, { a: flow({ flowId: "a", phase: "done" }) }, null)[0]).toMatchObject({ state: "connected" });
    expect(connectRows(integration, { a: flow({ flowId: "a", phase: "cancelled" }) }, null)[0].flow).toBeUndefined();
    // Another server's flow is not this one's.
    expect(connectRows(integration, { a: flow({ flowId: "a", phase: "queued", serverName: "other" }) }, null)[0].flow).toBeUndefined();
  });

  it("counts connected agents and queues only those that wait for no sign-in yet", () => {
    const rows = connectRows(
      jira([runtime({ status: "needs_auth" }), runtime({ runtimeId: "codex", status: "needs_auth" })]),
      { a: flow({ flowId: "a", phase: "awaiting_user", runtimeId: "codex" }) },
      null,
    );
    expect(connectProgress(rows)).toEqual({ connected: 0, total: 2 });
    expect(pendingTargets(rows)).toEqual([{ runtimeId: "claude", serverName: "atlassian" }]);
  });
});

describe("checkCallbackPaste", () => {
  it("takes the address the browser ended on, with the code and this flow's state", () => {
    expect(checkCallbackPaste(" http://localhost:1/callback?code=c&state=s ", { state: "s" })).toEqual({ ok: true, url: "http://localhost:1/callback?code=c&state=s" });
    // A server's refusal is the relay's to report.
    expect(checkCallbackPaste("http://localhost:1/callback?error=access_denied&state=s", { state: "s" }).ok).toBe(true);
  });

  it("refuses what cannot finish this sign-in", () => {
    expect(checkCallbackPaste("hello", { state: "s" })).toEqual({ ok: false, error: "not_url" });
    expect(checkCallbackPaste("http://localhost:1/callback?state=s", { state: "s" })).toEqual({ ok: false, error: "missing_code" });
    expect(checkCallbackPaste("http://localhost:1/callback?code=c", { state: "s" })).toEqual({ ok: false, error: "state_mismatch" });
    expect(checkCallbackPaste("http://localhost:1/callback?code=c&state=t", { state: "s" })).toEqual({ ok: false, error: "state_mismatch" });
  });
});

describe("integrationForServer", () => {
  it("finds the integration whose server for the chat's agent has the name", () => {
    const integrations = [jira([runtime({ runtimeId: "codex", serverName: "atlassian" })])];
    expect(integrationForServer(integrations, "codex", "atlassian")?.id).toBe("jira");
    expect(integrationForServer(integrations, "claude", "atlassian")).toBeUndefined();
    expect(integrationForServer(null, "claude", "atlassian")).toBeUndefined();
  });
});
