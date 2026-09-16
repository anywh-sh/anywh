import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import { parseEditorSsh, peerIsThisMachine, resolveEditorDescriptor } from "./editorHostInfo.js";

test("resolveEditorDescriptor: both env vars absent hides the feature", () => {
  assert.equal(resolveEditorDescriptor({}, "127.0.0.1"), null);
});

test("resolveEditorDescriptor: LOCAL set and peer is this machine resolves to local", () => {
  assert.deepEqual(resolveEditorDescriptor({ ANYWH_EDITOR_LOCAL: "1" }, "127.0.0.1"), { kind: "local" });
});

test("resolveEditorDescriptor: LOCAL set but peer is a different machine downgrades to ssh, never promotes", () => {
  const result = resolveEditorDescriptor(
    { ANYWH_EDITOR_LOCAL: "1", ANYWH_EDITOR_SSH: "wil@debian-headless" },
    "203.0.113.5",
  );
  assert.deepEqual(result, { kind: "ssh", user: "wil", host: "debian-headless" });
});

test("resolveEditorDescriptor: LOCAL set but peer is a different machine and no SSH configured hides the feature", () => {
  assert.equal(resolveEditorDescriptor({ ANYWH_EDITOR_LOCAL: "1" }, "203.0.113.5"), null);
});

test("resolveEditorDescriptor: SSH set and no LOCAL resolves to ssh regardless of peer", () => {
  const result = resolveEditorDescriptor({ ANYWH_EDITOR_SSH: "wil@100.64.0.1:2222" }, "127.0.0.1");
  assert.deepEqual(result, { kind: "ssh", user: "wil", host: "100.64.0.1", port: 2222 });
});

test("resolveEditorDescriptor: LOCAL takes priority over SSH when both are set and the peer is this machine", () => {
  const result = resolveEditorDescriptor(
    { ANYWH_EDITOR_LOCAL: "1", ANYWH_EDITOR_SSH: "wil@debian-headless" },
    "127.0.0.1",
  );
  assert.deepEqual(result, { kind: "local" });
});

test("resolveEditorDescriptor: LOCAL=0 (or any non-'1' value) is treated as unset", () => {
  assert.equal(resolveEditorDescriptor({ ANYWH_EDITOR_LOCAL: "0" }, "127.0.0.1"), null);
  assert.equal(resolveEditorDescriptor({ ANYWH_EDITOR_LOCAL: "" }, "127.0.0.1"), null);
});

test("parseEditorSsh: plain user@host with no port", () => {
  assert.deepEqual(parseEditorSsh("wil@debian-headless"), { user: "wil", host: "debian-headless" });
});

test("parseEditorSsh: user@host:port", () => {
  assert.deepEqual(parseEditorSsh("wil@100.64.0.1:2222"), { user: "wil", host: "100.64.0.1", port: 2222 });
});

test("parseEditorSsh: an ~/.ssh/config alias with no '@' is rejected, not misread as a bare host", () => {
  assert.equal(parseEditorSsh("my-headless-box"), null);
});

test("parseEditorSsh: malformed input returns null instead of throwing", () => {
  assert.equal(parseEditorSsh(undefined), null);
  assert.equal(parseEditorSsh(""), null);
  assert.equal(parseEditorSsh("   "), null);
  assert.equal(parseEditorSsh("@host"), null);
  assert.equal(parseEditorSsh("user@"), null);
  assert.equal(parseEditorSsh("user@host:not-a-port"), null);
  assert.equal(parseEditorSsh("user@host:0"), null);
  assert.equal(parseEditorSsh("user@host:-1"), null);
});

test("peerIsThisMachine: loopback (both IPv4 and the IPv4-mapped IPv6 form) counts as this machine", () => {
  assert.equal(peerIsThisMachine("127.0.0.1"), true);
  assert.equal(peerIsThisMachine("::1"), true);
  assert.equal(peerIsThisMachine("::ffff:127.0.0.1"), true);
});

test("peerIsThisMachine: an address that belongs to none of this machine's own interfaces is not this machine", () => {
  assert.equal(peerIsThisMachine("203.0.113.5"), false);
  assert.equal(peerIsThisMachine(undefined), false);
});

test("peerIsThisMachine: a real address of one of this machine's own interfaces counts, guarding against the self-host Tailscale false negative", () => {
  const ownAddress = Object.values(networkInterfaces())
    .flat()
    .find((addr) => addr && !addr.internal)?.address;
  if (!ownAddress) return; // no non-loopback interface on this runner; nothing to assert
  assert.equal(peerIsThisMachine(ownAddress), true);
});
