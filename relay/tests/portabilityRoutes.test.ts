import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the two
// `/control/portability` routes against a running relay, a real profile
// home on disk, and the real `claude` def's own declared paths — the flow
// the "bring my configuration" checkbox performs, minus the checkbox.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function write(home: string, relativePath: string, contents: string): void {
  const absolute = join(home, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

interface Snapshot {
  runtimeId: string;
  found: boolean;
  files: { path: string; bytes: number }[];
  mcpServers: string[];
  warnings: { kind: string; path: string; detail: string }[];
}

test("GET /control/portability: an empty profile home has nothing to carry", async () => {
  const response = await fetch(httpUrl("/control/portability?runtime=claude"));
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as Snapshot;
  assert.equal(snapshot.runtimeId, "claude");
  assert.equal(snapshot.found, false, "the test server's $HOME starts bare");
});

test("GET /control/portability: reports a real config home under an explicit home, contents withheld until asked", async () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-portability-home-"));
  write(home, ".claude/CLAUDE.md", "# My instructions\n");
  write(home, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\n");
  write(home, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ command: "/home/someone/bin/lint" }] } }));
  write(home, ".claude.json", JSON.stringify({ machineID: "abc", mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } } }));

  const summary = (await (await fetch(httpUrl(`/control/portability?runtime=claude&home=${encodeURIComponent(home)}`))).json()) as Snapshot;
  assert.equal(summary.found, true);
  assert.deepEqual(summary.files.map((file) => file.path).sort(), [".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills/deploy/SKILL.md"]);
  assert.deepEqual(summary.mcpServers, ["sentry"]);
  assert.ok(
    summary.warnings.some((warning) => warning.kind === "absolute-path" && warning.detail.includes("/home/someone/bin/lint")),
    "the hook that won't resolve on the destination is surfaced, not silently dropped",
  );
  assert.ok(!JSON.stringify(summary).includes("My instructions"), "the summary answers 'is there anything', not 'give it to me'");

  const full = (await (await fetch(httpUrl(`/control/portability?runtime=claude&full=1&home=${encodeURIComponent(home)}`))).json()) as {
    files: { path: string; contents: string }[];
    declaration: { path: string; format: string; values: Record<string, unknown> };
  };
  const instructions = full.files.find((file) => file.path === ".claude/CLAUDE.md");
  assert.equal(Buffer.from(instructions?.contents ?? "", "base64").toString("utf8"), "# My instructions\n");
  assert.deepEqual(Object.keys(full.declaration.values), ["mcpServers"], "only the allowlisted key of a 100 KB shared file crosses");
  assert.ok(!JSON.stringify(full.declaration.values).includes("abc"), "machineID stays on the machine it identifies");
});

test("POST /control/portability/apply: writes a bundle into another home, merging the declaration", async () => {
  const source = mkdtempSync(join(tmpdir(), "anywh-portability-source-"));
  write(source, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\n");
  write(source, ".claude.json", JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } } }));

  const destination = mkdtempSync(join(tmpdir(), "anywh-portability-destination-"));
  // A home a CLI already wrote into once — the machine state that must
  // survive a merge that isn't a file copy.
  write(destination, ".claude.json", JSON.stringify({ machineID: "destination-machine", userID: "u-1" }));

  const bundle = await (await fetch(httpUrl(`/control/portability?runtime=claude&full=1&home=${encodeURIComponent(source)}`))).json();
  const applied = await fetch(httpUrl(`/control/portability/apply?home=${encodeURIComponent(destination)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  assert.equal(applied.status, 200);
  const result = (await applied.json()) as { written: string[]; rejected: string[] };
  assert.deepEqual(result.rejected, []);
  assert.ok(result.written.includes(".claude/skills/deploy/SKILL.md"));

  assert.equal(readFileSync(join(destination, ".claude/skills/deploy/SKILL.md"), "utf8"), "---\nname: deploy\n---\n");
  const merged = JSON.parse(readFileSync(join(destination, ".claude.json"), "utf8")) as Record<string, unknown>;
  assert.equal(merged.machineID, "destination-machine", "the destination's own identity is not overwritten by the source's");
  assert.deepEqual(merged.mcpServers, { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } });
});

test("POST /control/portability/apply: a path climbing out of the home is refused, the rest still lands", async () => {
  const destination = mkdtempSync(join(tmpdir(), "anywh-portability-hostile-"));
  const response = await fetch(httpUrl(`/control/portability/apply?home=${encodeURIComponent(destination)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bundle: {
        runtimeId: "claude",
        files: [
          { path: "../../.ssh/authorized_keys", contents: Buffer.from("ssh-rsa AAAA").toString("base64"), executable: false, bytes: 12 },
          { path: ".claude/skills/ok/SKILL.md", contents: Buffer.from("fine").toString("base64"), executable: false, bytes: 4 },
        ],
        mcpServers: [],
        warnings: [],
      },
    }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { written: string[]; rejected: string[] };
  assert.deepEqual(result.rejected, ["../../.ssh/authorized_keys"]);
  assert.deepEqual(result.written, [".claude/skills/ok/SKILL.md"]);
});

test("both routes refuse a runtime no def answers to, and a relative home", async () => {
  const unknown = await fetch(httpUrl("/control/portability?runtime=not-a-runtime"));
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as { error: string }).error, /unknown runtime/);

  const relativeHome = await fetch(httpUrl("/control/portability?runtime=claude&home=relative/path"));
  assert.equal(relativeHome.status, 400);

  const badBundle = await fetch(httpUrl("/control/portability/apply"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle: { files: [] } }),
  });
  assert.equal(badBundle.status, 400);
});
