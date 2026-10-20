// The `room` field of the sessions file: persisted, validated on load like
// the pending question, and invisible to every session that has none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./sessionStore.js";
import type { RoomMembership } from "./room.js";

const DEFAULT_CWD = "/home/user";

function withDir(run: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-store-room-"));
  try {
    run(join(dir, "sessions.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const principal: RoomMembership = { roomId: "p1", role: "principal", createdBy: "user", task: "", undeliveredReports: ["w1"] };
const worker: RoomMembership = {
  roomId: "p1",
  role: "worker",
  parentId: "p1",
  createdBy: "agent",
  task: "count lines",
  report: { status: "done", summary: "42 lines", artifacts: ["out.md"], at: 1000 },
};

test("a room membership survives a reload byte for byte, and the store hands out copies", () => {
  withDir((file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    store.recordId("p1");
    store.setRoom("p1", principal);
    store.setRoom("w1", worker);
    const copy = store.getRoom("p1")!;
    copy.undeliveredReports!.push("mutated");

    const reloaded = new SessionStore(file, DEFAULT_CWD);
    assert.deepEqual(reloaded.getRoom("p1"), principal);
    assert.deepEqual(reloaded.getRoom("w1"), worker);
    assert.deepEqual(
      reloaded.listRoomMembers("p1").map((member) => member.id).sort(),
      ["p1", "w1"],
    );
    reloaded.setRoom("w1", undefined);
    assert.equal(new SessionStore(file, DEFAULT_CWD).getRoom("w1"), undefined);
  });
});

test("a malformed room record is dropped on load, the session itself kept, and the file rewritten", () => {
  withDir((file) => {
    const base = { agentId: "claude", sessionId: {}, title: "kept", cwd: { cwd: "/x", locked: false }, lastActiveAt: 5 };
    writeFileSync(
      file,
      JSON.stringify({
        good: { ...base, room: worker },
        bad: { ...base, room: { roomId: "p1", role: "lead", createdBy: "agent", task: "" } },
      }),
    );
    const store = new SessionStore(file, DEFAULT_CWD);
    assert.deepEqual(store.getRoom("good"), worker);
    assert.equal(store.getRoom("bad"), undefined);
    assert.equal(store.getTitle("bad"), "kept");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, { room?: unknown }>;
    assert.equal(onDisk.bad.room, undefined, "rewritten without the bad record");
    assert.deepEqual(onDisk.good.room, worker);
  });
});

test("workers are left out of the sidebar list; principals and ordinary sessions are not", () => {
  withDir((file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    store.setTitle("plain", "Plain session");
    store.setTitle("p1", "The room");
    store.setRoom("p1", principal);
    store.setTitle("w1", "A worker");
    store.setRoom("w1", worker);
    assert.deepEqual(
      store.listTitled().map((row) => row.id).sort(),
      ["p1", "plain"],
    );
  });
});

test("a sessions file with no rooms loads and saves exactly as before", () => {
  withDir((file) => {
    const before = {
      s1: { agentId: "claude", sessionId: { claude: "abc" }, title: "t", cwd: { cwd: "/x", locked: true }, lastActiveAt: 9, draft: "hi" },
    };
    writeFileSync(file, JSON.stringify(before));
    const store = new SessionStore(file, DEFAULT_CWD);
    assert.equal(store.getRoom("s1"), undefined);
    store.setDraft("s1", "hi again");
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
    assert.equal("room" in after.s1, false);
    assert.deepEqual({ ...after.s1, draft: "hi" }, before.s1);
  });
});
