import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Profile } from "@/lib/profiles/profiles";

const { resolveConnectionMock } = vi.hoisted(() => ({ resolveConnectionMock: vi.fn() }));
vi.mock("@/lib/profiles/connectionResolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/connectionResolver")>()),
  resolveConnection: resolveConnectionMock,
}));

import { subtasksKey, useAgentSubtasks } from "@/hooks/sala/useAgentSubtasks";
import type { RoomSubtaskView } from "@/lib/relay/roomClient";

const profile: Profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 0 };
const view = (taskId: string, status: RoomSubtaskView["status"]): RoomSubtaskView => ({ taskId, toolUseId: `tu-${taskId}`, status, startedAt: 1 });

beforeEach(() => {
  resolveConnectionMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 1, token: "t" });
});
afterEach(() => vi.unstubAllGlobals());

describe("subtasksKey", () => {
  it("changes when a subtask starts, ends or is stopped, and not for anything else", () => {
    const base = subtasksKey({ subtasksRunning: 1, subtasks: [view("a", "running")] });
    expect(subtasksKey({ subtasksRunning: 1, subtasks: [view("a", "running")] })).toBe(base);
    expect(subtasksKey({ subtasksRunning: 2, subtasks: [view("a", "running"), view("b", "running")] })).not.toBe(base);
    expect(subtasksKey({ subtasksRunning: 0, subtasks: [view("a", "completed")] })).not.toBe(base);
    expect(subtasksKey({ subtasksRunning: 0 })).toBe("0:");
  });
});

describe("useAgentSubtasks", () => {
  it("reads the list again when the key changes, and not while it holds", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ subtasks: [] }))));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderHook(({ key }) => useAgentSubtasks(profile, "room", "agent", key), { initialProps: { key: "1:a=running" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ key: "1:a=running" });
    rerender({ key: "0:a=completed" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toContain("/rooms/room/agents/agent/subtasks");
  });
});
