import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRecord } from "./bot.js";
import { BotStore, botsPathFor } from "./botStore.js";

const bot = (id: string): BotRecord => ({ id, name: id, mascot: { character: "bip", tone: "sand" }, roomId: `room-${id}`, paused: false, firstRun: true, createdAt: 1, nextTaskN: 1, tasks: [], schedules: [] });

test("the bots file sits beside the sessions file", () => {
  assert.equal(botsPathFor("/x/pessoal.json"), "/x/pessoal-bots.json");
});

test("bots survive a restart; an invalid record is dropped and the rest kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bots-"));
  try {
    const file = join(dir, "p-bots.json");
    const store = new BotStore(file);
    store.put(bot("a"));
    store.put(bot("b"));
    const written = JSON.parse(readFileSync(file, "utf8")) as { bots: unknown[] };
    written.bots.push({ id: "broken" });
    writeFileSync(file, JSON.stringify(written));
    const reloaded = new BotStore(file);
    assert.deepEqual(reloaded.list().map((each) => each.id), ["a", "b"]);
    assert.equal(reloaded.byRoom("room-b")?.id, "b");
    assert.equal(reloaded.isBotRoom("room-a"), true);
    assert.equal(reloaded.delete("a"), true);
    assert.deepEqual(new BotStore(file).list().map((each) => each.id), ["b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that does not parse is set aside, never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bots-"));
  try {
    const file = join(dir, "p-bots.json");
    writeFileSync(file, "{ not json");
    const store = new BotStore(file, () => 42);
    assert.deepEqual(store.list(), []);
    assert.equal(existsSync(file), false);
    assert.ok(readdirSync(dir).includes("p-bots.json.corrupt-42"));
    assert.equal(readFileSync(join(dir, "p-bots.json.corrupt-42"), "utf8"), "{ not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
