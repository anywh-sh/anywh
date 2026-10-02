import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeToolFilter } from "./bridgeToolFilter.js";

test("a bridge call is hidden from start to end, including its context attribution", () => {
  const filter = new BridgeToolFilter();
  assert.equal(
    filter.shouldHide({
      type: "tool_started",
      toolUseId: "a",
      name: "mcp__anywh-choice__present_choice",
      kind: "mcp",
      input: {},
      subject: { kind: "mcp", server: "anywh-choice", tool: "present_choice" },
    }),
    true,
  );
  assert.equal(filter.shouldHide({ type: "tool_ended", toolUseId: "a", content: "{}", isError: false }), true);
  assert.equal(filter.shouldHide({ type: "context_attribution", toolUseIds: ["a"], tokens: 10, estimated: false }), true);
});

test("the approval bridge is hidden too, whichever runtime reported it", () => {
  const filter = new BridgeToolFilter();
  assert.equal(
    filter.shouldHide({ type: "tool_started", toolUseId: "p", name: "x", kind: "mcp", input: {}, subject: { kind: "mcp", server: "anywh-permission", tool: "approve" } }),
    true,
  );
});

test("any other MCP server, and every non-MCP call, stays visible", () => {
  const filter = new BridgeToolFilter();
  assert.equal(
    filter.shouldHide({ type: "tool_started", toolUseId: "l", name: "x", kind: "mcp", input: {}, subject: { kind: "mcp", server: "linear", tool: "list_issues" } }),
    false,
  );
  assert.equal(filter.shouldHide({ type: "tool_ended", toolUseId: "l", content: "", isError: false }), false);
  assert.equal(filter.shouldHide({ type: "tool_started", toolUseId: "b", name: "Bash", kind: "shell", input: {} }), false);
  assert.equal(filter.shouldHide({ type: "context_attribution", toolUseIds: ["b"], tokens: 1, estimated: false }), false);
});
