import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.equal(env.RELAY_DATA_DIR, root);
    // One root, not a line per feature: the relay derives rooms/ and bots/.
    assert.equal(env.RELAY_ROOM_CONTEXT_DIR, undefined);
    assert.equal(env.RELAY_BOT_DIR, undefined);
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
    assert.equal(env.RELAY_DATA_DIR, join(home, "cfg"));
    assert.equal(env.ANYWH_EDITOR_SSH, "me@host");
    // Written once each, not appended again on every resume.
    const text = readFileSync(join(envDir, "work.env"), "utf8");
    assert.equal(text.match(/^CLAUDE_CONFIG_DIR=/gm)?.length, 1);
    assert.equal(text.match(/^RELAY_DATA_DIR=/gm)?.length, 1);
    assert.equal(text.match(/^RELAY_PORT=/gm)?.length, 1);
  });
});

test("--resume with no --label keeps the profile's label and the app's own fields in profiles.json", () => {
  withHome((home, envDir) => {
    addProfile(home, envDir, ["default", "--label", "Personal"]);
    const registryPath = join(dirname(envDir), "profiles.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { profiles: Record<string, unknown>[] };
    registry.profiles[0].agentPreference = { mode: "fixed", fixedAgentId: "claude" };
    writeFileSync(registryPath, JSON.stringify(registry));
    addProfile(home, envDir, ["default", "--resume"]);
    const [entry] = (JSON.parse(readFileSync(registryPath, "utf8")) as { profiles: Record<string, unknown>[] }).profiles;
    assert.equal(entry.label, "Personal");
    assert.deepEqual(entry.agentPreference, { mode: "fixed", fixedAgentId: "claude" });
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

// The macOS app ships the script inside the relay's SEA tree (the binary at
// the tree's root, infra/ beside it) to Macs that have no Node. There the
// registry write must go through the binary, never `node`. The binary here
// runs the real sea-entry.cjs against the compiled dist/ (`npm run build`),
// which is all the SEA bundles.
const RELAY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The app's layout: `<support>/relay/` (binary, infra/), with `launchd/`
 * beside it. Returns the tree and a PATH whose `node` only fails. */
function seaTree(home: string): { tree: string; path: string } {
  assert.ok(existsSync(join(RELAY_DIR, "dist/host/recordProfile.js")), "run `npm run build` in relay/ first");
  const tree = join(home, "support/relay");
  cpSync(resolve(RELAY_DIR, "../infra"), join(tree, "infra"), { recursive: true });
  const bin = join(tree, "anywh-relay");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(RELAY_DIR, "sea-build/sea-entry.cjs")}" "$@"\n`);
  chmodSync(bin, 0o755);
  const noNode = join(home, "no-node");
  mkdirSync(noNode);
  writeFileSync(join(noNode, "node"), "#!/bin/sh\necho 'node must not run here' >&2\nexit 127\n");
  chmodSync(join(noNode, "node"), 0o755);
  return { tree, path: `${noNode}:/usr/bin:/bin` };
}

test("inside the SEA tree, the profile is recorded by the binary, not by node", () => {
  withHome((home, envDir) => {
    const { tree, path } = seaTree(home);
    execFileSync("bash", [join(tree, "infra/systemd/add-profile.sh"), "work", "--label", "Work", "--relay-host", "127.0.0.2", "--mode", "dev"], {
      env: { ...process.env, HOME: home, ANYWH_ENV_DIR: envDir, PATH: path },
      encoding: "utf8",
    });
    const registry = JSON.parse(readFileSync(join(dirname(envDir), "profiles.json"), "utf8")) as {
      profiles: { id: string; label: string; colorIndex: number }[];
    };
    assert.deepEqual(
      registry.profiles.map((p) => [p.id, p.label, p.colorIndex]),
      [["work", "Work", 0]],
    );
  });
});

const FAKE_LAUNCHCTL = resolve(RELAY_DIR, "tests/fixtures/fake-launchctl.sh");

test("the app's relay: --mode prod writes the profile's two launchd jobs beside the tree and bootstraps them", () => {
  withHome((home, envDir) => {
    const { tree, path } = seaTree(home);
    const argvFile = join(home, "launchctl-argv");
    const run = (loaded: string) =>
      execFileSync("bash", [join(tree, "infra/systemd/add-profile.sh"), "work", "--relay-host", "127.0.0.2", "--port", "1", "--mode", "prod", "--resume"], {
        env: {
          ...process.env,
          HOME: home,
          ANYWH_ENV_DIR: envDir,
          PATH: path,
          ANYWH_RELAY_MANAGED_BY_APP: "1",
          LAUNCHCTL_BIN: FAKE_LAUNCHCTL,
          FAKE_LAUNCHCTL_ARGV_FILE: argvFile,
          FAKE_LAUNCHCTL_LOADED: loaded,
          // Nothing listens: one attempt, not the default 30 s.
          ANYWH_RELAY_READY_TIMEOUT: "0",
          // Never the real systemctl, whatever this branch does.
          SYSTEMCTL_BIN: "/bin/false",
        },
        encoding: "utf8",
      });
    run("");

    const launchd = join(home, "support/launchd");
    const relayPlist = readFileSync(join(launchd, "sh.anywh.relay.work.plist"), "utf8");
    const hostPlist = readFileSync(join(launchd, "sh.anywh.agent-host.work.plist"), "utf8");
    const bin = join(tree, "anywh-relay");
    assert.match(relayPlist, new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*<string>${bin}</string>\\s*</array>`));
    assert.match(hostPlist, new RegExp(`<string>${bin}</string>\\s*<string>agent-host</string>\\s*<string>--profile</string>\\s*<string>work</string>`));
    for (const plist of [relayPlist, hostPlist]) {
      // launchd starts a job in `/`, which is read-only.
      assert.match(plist, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${home}/.anywh-sessions</string>`));
      assert.match(plist, new RegExp(`<key>RELAY_ENV_FILE</key>\\s*<string>${envDir}/work.env</string>`));
      assert.match(plist, /<key>ANYWH_RESTART_ON_UPDATE<\/key>\s*<string>1<\/string>/);
      assert.match(plist, /<key>ANYWH_RELAY_MANAGED_BY_APP<\/key>\s*<string>1<\/string>/);
      assert.match(plist, new RegExp(`<key>ANYWH_LAUNCHD_DIR</key>\\s*<string>${launchd}</string>`));
      assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    }
    assert.match(relayPlist, new RegExp(`<key>StandardOutPath</key>\\s*<string>${home}/.anywh-sessions/work-relay.log</string>`));

    const uid = process.getuid!();
    assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), [
      `print gui/${uid}/sh.anywh.agent-host.work`,
      `bootstrap gui/${uid} ${launchd}/sh.anywh.agent-host.work.plist`,
      `print gui/${uid}/sh.anywh.relay.work`,
      `bootstrap gui/${uid} ${launchd}/sh.anywh.relay.work.plist`,
    ]);

    // Running again with both loaded leaves them as they are.
    rmSync(argvFile);
    const out = run("sh.anywh.agent-host.work sh.anywh.relay.work");
    assert.match(out, /sh\.anywh\.relay\.work is already running; left as is/);
    assert.ok(!readFileSync(argvFile, "utf8").includes("bootstrap"));
  });
});
