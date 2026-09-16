import { strict as assert } from "node:assert";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { resolveAgentBin, SCRIPTS_DIR } from "./executables.js";

// `../../scripts` from this file's own new location is exactly the segment
// that a directory move under `src/` silently breaks: it keeps resolving to
// *some* path and only fails at spawn time, in a turn, when `anywh-bg` isn't
// on PATH. Pinning it here turns that failure mode into a red unit test.
test("SCRIPTS_DIR resolves to the real relay/scripts, with anywh-bg present and executable", () => {
  assert.doesNotThrow(() => accessSync(join(SCRIPTS_DIR, "anywh-bg"), constants.X_OK));
});

// Real files with real permission bits, not a mocked `fs`: what this
// function decides is whether something on disk is executable, and a stub
// for that would only assert that the stub was called.
let root = "";
let onPath = "";
let wellKnown = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "anywh-agent-bin-"));
  onPath = join(root, "on-path");
  wellKnown = join(root, "well-known");
  mkdirSync(onPath);
  mkdirSync(wellKnown);
});

after(() => rmSync(root, { recursive: true, force: true }));

function install(dir: string, name: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
  return path;
}

describe("resolveAgentBin", () => {
  it("leaves a bare name alone when the relay's own PATH has it", () => {
    install(onPath, "agent-on-path");
    assert.equal(resolveAgentBin("agent-on-path", { PATH: onPath }, [wellKnown]), "agent-on-path");
  });

  it("finds the CLI in a well-known bin dir when PATH doesn't have it", () => {
    // The launchd case: PATH is /usr/bin:/bin:/usr/sbin:/sbin and the CLI
    // is in ~/.local/bin, so spawning it by name fails with ENOENT for a
    // binary that is right there.
    const installed = install(wellKnown, "agent-well-known");
    assert.equal(resolveAgentBin("agent-well-known", { PATH: "/usr/bin:/bin" }, [wellKnown]), installed);
  });

  it("prefers PATH over the fallback dirs when both have it", () => {
    install(onPath, "agent-both");
    install(wellKnown, "agent-both");
    assert.equal(resolveAgentBin("agent-both", { PATH: onPath }, [wellKnown]), "agent-both");
  });

  it("ignores a match that isn't executable", () => {
    install(wellKnown, "agent-not-executable", 0o644);
    assert.equal(resolveAgentBin("agent-not-executable", { PATH: "/usr/bin" }, [wellKnown]), "agent-not-executable");
  });

  it("returns a name it can't find anywhere unchanged", () => {
    // The relay stays up and serving with no agent CLI installed; the turn
    // that tries to spawn one is where that gets reported.
    assert.equal(resolveAgentBin("agent-nowhere", { PATH: "/usr/bin" }, [wellKnown]), "agent-nowhere");
  });

  it("never second-guesses a path the operator spelled out", () => {
    // An explicit AGENT_BIN names one binary on purpose — resolving it to
    // a different one found elsewhere would silently run the wrong agent.
    assert.equal(resolveAgentBin("/opt/agents/bin/agent", { PATH: onPath }, [wellKnown]), "/opt/agents/bin/agent");
    assert.equal(resolveAgentBin("./agent", { PATH: onPath }, [wellKnown]), "./agent");
  });

  it("survives a PATH that is missing or empty", () => {
    const installed = install(wellKnown, "agent-no-path");
    assert.equal(resolveAgentBin("agent-no-path", {}, [wellKnown]), installed);
    assert.equal(resolveAgentBin("agent-no-path", { PATH: "" }, [wellKnown]), installed);
  });
});
