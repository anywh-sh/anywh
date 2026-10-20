import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_CANVAS, RoomCanvasStore, parseRoomCanvas, roomCanvasPathFor, type RoomCanvas } from "./roomCanvas.js";

const canvas: RoomCanvas = {
  positions: { p1: { x: 0, y: 0 }, w1: { x: 320, y: -40.5 } },
  areas: [{ id: "a1", label: "Code", x: 100, y: 100, width: 400, height: 300, members: ["w1"] }],
  texts: [{ id: "t1", text: "ship by friday", x: -10, y: 20 }],
  camera: { x: 12, y: -3, zoom: 0.8 },
};

test("parseRoomCanvas keeps a well-formed canvas, fills defaults and drops unknown keys", () => {
  assert.deepEqual(parseRoomCanvas(canvas), canvas);
  assert.deepEqual(parseRoomCanvas({}), EMPTY_CANVAS);
  assert.deepEqual(parseRoomCanvas({ ...canvas, extra: true }), canvas);
});

test("parseRoomCanvas rejects the whole canvas when any part is malformed", () => {
  const bad: [string, unknown][] = [
    ["not an object", []],
    ["position not a point", { positions: { w1: { x: "1", y: 0 } } }],
    ["position not finite", { positions: { w1: { x: Infinity, y: 0 } } }],
    ["area without label", { areas: [{ id: "a", x: 0, y: 0 }] }],
    ["area member not an id", { areas: [{ id: "a", label: "x", x: 0, y: 0, members: [""] }] }],
    ["negative width", { areas: [{ id: "a", label: "x", x: 0, y: 0, width: -1 }] }],
    ["text too long", { texts: [{ id: "t", text: "x".repeat(5000), x: 0, y: 0 }] }],
    ["zoom zero", { camera: { x: 0, y: 0, zoom: 0 } }],
    ["areas not a list", { areas: {} }],
  ];
  for (const [what, value] of bad) assert.equal(parseRoomCanvas(value), undefined, what);
});

test("the sidecar sits beside the sessions file", () => {
  assert.equal(roomCanvasPathFor("/h/.anywh-sessions/pessoal.json"), "/h/.anywh-sessions/pessoal-rooms.json");
  assert.equal(roomCanvasPathFor("./sessions"), "./sessions-rooms.json");
});

test("RoomCanvasStore persists per room, privately, and drops a bad room on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-room-canvas-"));
  try {
    const file = join(dir, "p-rooms.json");
    const store = new RoomCanvasStore(file);
    assert.deepEqual(store.get("p1"), EMPTY_CANVAS);
    store.set("p1", canvas);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(new RoomCanvasStore(file).get("p1"), canvas);

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...onDisk, broken: { positions: "nope" } }));
    const reloaded = new RoomCanvasStore(file);
    assert.deepEqual(reloaded.get("p1"), canvas);
    assert.deepEqual(reloaded.get("broken"), EMPTY_CANVAS);
    assert.equal("broken" in (JSON.parse(readFileSync(file, "utf8")) as object), false, "rewritten without it");

    reloaded.delete("p1");
    assert.deepEqual(new RoomCanvasStore(file).get("p1"), EMPTY_CANVAS);
    writeFileSync(file, "{not json");
    assert.deepEqual(new RoomCanvasStore(file).get("p1"), EMPTY_CANVAS, "a corrupt file never crashes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
