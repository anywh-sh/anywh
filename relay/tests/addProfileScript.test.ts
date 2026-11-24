import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The real infra/systemd/add-profile.sh, run in --mode dev against a
// throwaway $HOME and env dir: nothing here reaches systemd, and every
// file it writes lives in the tmpdir.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../infra/systemd/add-profile.sh");

function withHome(run: (home: string, envDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "anywh-add-profile-"));
  try {
    run(home, join(home, ".config/anywh/env"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function addProfile(home: string, envDir: string, args: readonly string[]): string {
  return execFileSync("bash", [SCRIPT, ...args, "--relay-host", "127.0.0.2", "--mode", "dev"], {
    env: { ...process.env, HOME: home, ANYWH_ENV_DIR: envDir },
    encoding: "utf8",
  });
}

function readEnv(envDir: string, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(envDir, `${id}.env`), "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

test("--config-root gives each agent CLI its own folder and the profile its own rooms and bots, keeping the real $HOME", () => {
  withHome((home, envDir) => {
    addProfile(home, envDir, ["work", "--config-root", "~/.anywh/profiles/work"]);
    const env = readEnv(envDir, "work");
    const root = join(home, ".anywh/profiles/work");
    assert.equal(env.CLAUDE_CONFIG_DIR, join(root, "claude"));
    assert.equal(env.CODEX_HOME, join(root, "codex"));
    assert.equal(env.KIMI_CODE_HOME, join(root, "kimi"));
    assert.equal(env.RELAY_ROOM_CONTEXT_DIR, join(root, "rooms"));
    assert.equal(env.RELAY_BOT_DIR, join(root, "bots"));
    assert.equal(env.RELAY_HOME_OVERRIDE, undefined);
    for (const sub of ["claude", "codex", "kimi", "rooms", "bots"]) assert.ok(statSync(join(root, sub)).isDirectory(), sub);
    // It holds the profile's agent credentials.
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });
});

test("--resume keeps the keys it doesn't write, config dirs included — the app's update path passes no --config-root", () => {
  withHome((home, envDir) => {
    addProfile(home, envDir, ["work", "--config-root", join(home, "cfg")]);
    appendFileSync(join(envDir, "work.env"), "ANYWH_EDITOR_SSH=me@host\n");
    addProfile(home, envDir, ["work", "--resume"]);
    const env = readEnv(envDir, "work");
    assert.equal(env.CLAUDE_CONFIG_DIR, join(home, "cfg/claude"));
    assert.equal(env.RELAY_ROOM_CONTEXT_DIR, join(home, "cfg/rooms"));
    assert.equal(env.RELAY_BOT_DIR, join(home, "cfg/bots"));
    assert.equal(env.ANYWH_EDITOR_SSH, "me@host");
    // Written once each, not appended again on every resume.
    const text = readFileSync(join(envDir, "work.env"), "utf8");
    assert.equal(text.match(/^CLAUDE_CONFIG_DIR=/gm)?.length, 1);
    assert.equal(text.match(/^RELAY_PORT=/gm)?.length, 1);
  });
});

test("a --resume refused for naming another config root leaves no folder behind", () => {
  withHome((home, envDir) => {
    addProfile(home, envDir, ["work", "--config-root", join(home, "cfg")]);
    assert.throws(() => addProfile(home, envDir, ["work", "--resume", "--config-root", join(home, "other")]), /differs/);
    // The relay would otherwise take an empty "other" folder for a draft.
    assert.equal(existsSync(join(home, "other")), false);
  });
});

test("--home and --config-root are refused together", () => {
  withHome((home, envDir) => {
    assert.throws(() => addProfile(home, envDir, ["work", "--home", join(home, "h"), "--config-root", join(home, "c")]), /pass one/);
  });
});

test("--env adds a line, and giving the key again replaces it instead of duplicating it", () => {
  withHome((home, envDir) => {
    addProfile(home, envDir, ["work", "--config-root", join(home, "cfg"), "--env", "ANYWH_CLAUDE_SHARED_MCP=/a/.claude.json"]);
    addProfile(home, envDir, ["work", "--resume", "--env", "ANYWH_CLAUDE_SHARED_MCP=/b/.claude.json"]);
    const text = readFileSync(join(envDir, "work.env"), "utf8");
    assert.equal(text.match(/^ANYWH_CLAUDE_SHARED_MCP=/gm)?.length, 1);
    assert.equal(readEnv(envDir, "work").ANYWH_CLAUDE_SHARED_MCP, "/b/.claude.json");
    assert.throws(() => addProfile(home, envDir, ["other", "--env", "not a pair"]), /KEY=VALUE/);
  });
});
