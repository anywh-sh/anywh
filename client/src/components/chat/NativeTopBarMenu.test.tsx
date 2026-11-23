import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ModelCatalog, PermissionModeOption } from "@/lib/relay/relay-types";

// The native shell is the boundary here: stand in for the plugin's IPC, keeping
// the handlers the component registers so a test can fire what native would.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  payloads: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { payload: unknown }) => {
    if (cmd === "plugin:native-chrome|set_top_bar_menu") ipc.payloads.push(args.payload);
    return Promise.resolve();
  },
  addPluginListener: (_plugin: string, event: string, cb: (event: unknown) => void) => {
    ipc.handlers.set(event, cb);
    return Promise.resolve({ unregister: () => Promise.resolve(ipc.handlers.delete(event)) });
  },
}));

import { NativeTopBarMenu } from "./NativeTopBarMenu";

const catalog: ModelCatalog = { options: [{ id: "opus", label: "Opus" }], defaultId: "opus" };
const permissionModes: PermissionModeOption[] = [{ id: "default", pausesForApproval: true }];

function renderMenu(over: Partial<Parameters<typeof NativeTopBarMenu>[0]> = {}) {
  const onChangeAgent = vi.fn();
  render(
    <NativeTopBarMenu
      catalog={catalog}
      model={null}
      locked={false}
      connected
      onChangeModel={() => {}}
      permissionMode="default"
      permissionModes={permissionModes}
      onChangePermissionMode={() => {}}
      effort={null}
      onChangeEffort={() => {}}
      agentId="claude"
      agents={["claude", "codex"]}
      onChangeAgent={onChangeAgent}
      {...over}
    />,
  );
  return onChangeAgent;
}

async function pickAgent(agentId: string) {
  await waitFor(() => expect(ipc.handlers.has("topBarAgentSelect")).toBe(true));
  ipc.handlers.get("topBarAgentSelect")!({ agentId });
}

afterEach(() => {
  cleanup();
  ipc.handlers.clear();
  ipc.payloads.length = 0;
});

describe("NativeTopBarMenu agent pick", () => {
  it("applies an agent the relay can run", async () => {
    const onChangeAgent = renderMenu();
    await pickAgent("codex");
    expect(onChangeAgent).toHaveBeenCalledWith("codex");
  });

  it("ignores an id the relay did not report", async () => {
    const onChangeAgent = renderMenu();
    await pickAgent("gemini");
    expect(onChangeAgent).not.toHaveBeenCalled();
  });

  it("ignores the current agent", async () => {
    const onChangeAgent = renderMenu();
    await pickAgent("claude");
    expect(onChangeAgent).not.toHaveBeenCalled();
  });

  it("ignores any pick once the conversation is locked", async () => {
    const onChangeAgent = renderMenu({ locked: true });
    await pickAgent("codex");
    expect(onChangeAgent).not.toHaveBeenCalled();
  });

  it("sends the agent entry, and clears it with the rest on unmount", async () => {
    renderMenu();
    await waitFor(() => expect(ipc.payloads).toHaveLength(1));
    expect(ipc.payloads[0]).toMatchObject({ agent: { currentId: "claude", options: [{ id: "claude" }, { id: "codex" }] } });
    cleanup();
    expect(ipc.payloads[ipc.payloads.length - 1]).toEqual({ model: null, mode: null, effort: null, agent: null });
  });
});
