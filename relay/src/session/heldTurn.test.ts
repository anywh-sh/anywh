import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../protocol/agent-event.js";
import { HeldTurn } from "./sharedSession.js";

const tool = (subject: Extract<AgentEvent, { type: "tool_started" }>["subject"]): AgentEvent => ({ type: "tool_started", name: "x", input: {}, ...(subject ? { subject } : {}) }) as unknown as AgentEvent;
const text = (value: string): AgentEvent => ({ type: "text", text: value });

test("a scheduled run may look things up and still end in silence", () => {
  const held = new HeldTurn(true);
  assert.equal(held.shouldRelease(text("Let me check.")), false);
  assert.equal(held.shouldRelease(tool({ kind: "shell", command: "gh run list" })), false);
  assert.equal(held.shouldRelease(text("NO_REPLY")), false);
  assert.equal(held.isNoReply(), true);
});

test("an edit or a new file releases a scheduled run: it is never hidden", () => {
  assert.equal(new HeldTurn(true).shouldRelease(tool({ kind: "edit", path: "/x/a.ts" })), true);
  assert.equal(new HeldTurn(true).shouldRelease(tool({ kind: "write", path: "/x/b.ts" })), true);
});

test("findings written after the last lookup are the answer, even with NO_REPLY after them", () => {
  const held = new HeldTurn(true);
  held.shouldRelease(tool({ kind: "shell", command: "gh run list" }));
  held.shouldRelease(text("The e2e job failed twice on main."));
  held.shouldRelease(text("NO_REPLY"));
  assert.equal(held.isNoReply(), false);
});

test("listing the other bots keeps a scheduled run silent; asking or handing off to one releases it", () => {
  const mcp = (name: string) => tool({ kind: "mcp", server: "anywh-room", tool: name });
  assert.equal(new HeldTurn(true).shouldRelease(mcp("bot_list")), false);
  assert.equal(new HeldTurn(true).shouldRelease(mcp("bot_status")), false);
  assert.equal(new HeldTurn(true).shouldRelease(mcp("bot_ask")), true);
  assert.equal(new HeldTurn(true).shouldRelease(mcp("bot_handoff")), true);
});
