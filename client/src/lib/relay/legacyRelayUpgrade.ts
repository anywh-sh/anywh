// The one update a relay from before self-update needs, done from the app.
//
// Such a relay cannot be asked to update itself (`POST /relay/update` does
// not exist on it), and the app cannot reach the machine it runs on except
// through the relay itself. Its embedded terminal is that way in: the same
// `/terminal` channel the terminal panel uses runs the installer and the
// restart on the relay's own machine, local or remote, with no copy-paste.
//
// Before running anything, the app checks that no conversation on that relay
// has a turn in flight (every conversation tells a client that connects
// whether one is running, `turn_state`), and waits for them to end: such a
// relay's restart only waits a bounded time for turns before cutting them.
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { isUnreleasedVersion } from "@/lib/install/appVersion";
import { compareVersions } from "@/lib/install/semver";
import { fetchSessions } from "@/lib/relay/relayClient";
import type { HostInfo } from "@/lib/relay/filesClient";

/** The relay half of the installer, served on its own. */
export const RELAY_INSTALLER_URL = "https://anywh.sh/install-relay";

/** What the command prints last, with its exit status. */
export const UPGRADE_EXIT_MARKER = "ANYWH_RELAY_UPGRADE_EXIT";

/** The Homebrew relay's upgrade and restart: what the relay's terminal runs
 * on a Mac, and what a person runs there by hand. The app's own run on this
 * Mac is the same steps in Rust (`BREW_UPGRADE_COMMAND`, relay_setup.rs). */
export const BREW_UPGRADE_STEPS = "brew upgrade anywh-relay && brew services restart anywh-relay";

/** The darwin command's exit status when the tap has no newer relay than
 * the one installed (the Homebrew tap follows stable releases, bumped once
 * one is published, so it can be behind the app). Nothing was restarted. */
export const NOTHING_NEWER_EXIT = 4;

/** The terminal the update runs in (one per conversation id, see `/terminal`). */
export const UPGRADE_TERMINAL_ID = "anywh-relay-upgrade";

/**
 * Whether this relay needs the one update by hand: it runs a release older
 * than the app and cannot update itself. A build from source on either side
 * has no release to compare or install.
 */
export function needsLegacyUpgrade(info: Pick<HostInfo, "version" | "features">, appVersion: string): boolean {
  if (info.features?.includes("self_update")) return false;
  if (info.version === undefined || isUnreleasedVersion(info.version) || isUnreleasedVersion(appVersion)) return false;
  const vsApp = compareVersions(info.version, appVersion);
  return vsApp !== null && vsApp < 0;
}

/**
 * The shell line that updates the relay on its own machine and restarts it,
 * ending with `UPGRADE_EXIT_MARKER=<status>`. Wrapped in `sh -c '...'` so it
 * means the same under whatever shell the terminal opens (bash, zsh, fish).
 *
 * Linux: which service to update is found on that machine, never guessed
 * from the app's profile id (an imported profile's id names no unit). The
 * terminal runs inside the relay's own service, so its cgroup names the
 * unit; failing that, the unit of whatever listens on the relay's port. It
 * is then updated only if it is running from a tree the installer laid out
 * (a built relay next to the installer's infra/, not a source checkout):
 * the installer swaps `<dir>/relay` and `<dir>/infra` wholesale, wherever it
 * is pointed, so anything else refuses before touching a file. The
 * installer is downloaded to a file first, so a failed download fails the
 * command instead of feeding an empty script to `sh`. `unit` overrides the
 * detection (tests).
 *
 * macOS: Homebrew owns the relay, so it is upgraded and restarted there.
 * `null` for any other platform: there is nothing to run.
 */
export function upgradeCommand(options: { platform: string; port: number; version: string; installerUrl?: string; unit?: string }): string | null {
  const { platform, port, version } = options;
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const done = `echo ${UPGRADE_EXIT_MARKER}=$?`;
  if (platform === "linux") {
    if (options.unit !== undefined && !/^[A-Za-z0-9@._-]+$/.test(options.unit)) return null;
    const installer = options.installerUrl ?? RELAY_INSTALLER_URL;
    const unitOf = (file: string) => `sed -n "s|^.*/\\(anywh-relay@[a-z0-9-]*\\.service\\)$|\\1|p" ${file} | head -n 1`;
    const steps = [
      `set -u`,
      options.unit !== undefined
        ? `unit=${options.unit}`
        : `unit="$(${unitOf("/proc/self/cgroup")})"; if [ -z "$unit" ] && command -v ss >/dev/null 2>&1; then pid="$(ss -ltnpH "sport = :${String(port)}" 2>/dev/null | sed -n "s/.*pid=\\([0-9]*\\).*/\\1/p" | head -n 1)"; if [ -n "$pid" ]; then unit="$(${unitOf('"/proc/$pid/cgroup"')})"; fi; fi`,
      `run=""; if [ -n "$unit" ]; then run="$(systemctl --user show -p WorkingDirectory --value "$unit" 2>/dev/null)"; fi`,
      `dir="$(dirname "$run")"`,
      // The failure line and its status are echoed with quotes splitting
      // them, so the command line the terminal echoes back never reads as
      // that failure itself.
      `if [ -z "$unit" ] || [ "$(systemctl --user is-active "$unit" 2>/dev/null)" != active ] || [ "$(basename "$run")" != relay ] || [ ! -f "$run/dist/server.js" ] || [ ! -f "$dir/infra/systemd/add-profile.sh" ] || [ -e "$dir/.git" ]; then echo "ANYWH" "fail check not_installed no running relay installed from a release serves port ${String(port)}"; echo "${UPGRADE_EXIT_MARKER}"=3; exit 0; fi`,
      // The service's own Node first: the installer needs one, and a
      // service's PATH often lacks it (nvm).
      `node_bin="$(systemctl --user show -p ExecStart --value "$unit" | sed -n "s/^{ path=\\([^ ;]*\\).*/\\1/p")"`,
      `if [ -n "$node_bin" ]; then PATH="$(dirname "$node_bin"):$PATH"; fi`,
      `ANYWH_INSTALL_DIR="$dir"; export ANYWH_INSTALL_DIR PATH`,
      `script="$(mktemp)"`,
      `curl -fsSL ${installer} -o "$script" && sh "$script" --version v${version} --porcelain && systemctl --user --no-block try-restart "$unit"`,
      `status=$?; rm -f "$script"; echo ${UPGRADE_EXIT_MARKER}=$status`,
    ];
    return ` sh -c '${steps.join("; ")}'`;
  }
  if (platform === "darwin") {
    // Upgraded and restarted only when the tap has a newer relay than the
    // one installed; otherwise it ends with NOTHING_NEWER_EXIT and leaves
    // the relay running as it was (`(exit N)` sets the status the marker
    // echoes without the number ever appearing next to the marker in the
    // command line the terminal echoes back).
    const outdated = "brew outdated --quiet anywh-relay | grep -q anywh-relay";
    return ` sh -c 'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; brew update >/dev/null && brew list --versions anywh-relay >/dev/null && if ${outdated}; then ${BREW_UPGRADE_STEPS}; else (exit ${String(NOTHING_NEWER_EXIT)}); fi; ${done}'`;
  }
  return null;
}

// Terminal output carries escape sequences (colours, cursor moves, tmux's
// redraws); the markers are read from the text without them.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][0-9A-B]|\r/g;

export interface UpgradeOutcome {
  /** The command's exit status, once it printed it. */
  exitCode?: number;
  /** The installer's own reason, when it failed one of its steps. */
  failure?: string;
}

/** Reads what the command printed so far: its exit status (the echoed
 * command line itself only shows `=$?`, never a number) and the installer's
 * failure line, if any. */
export function parseUpgradeOutput(raw: string): UpgradeOutcome {
  const text = raw.replace(ANSI, "");
  const outcome: UpgradeOutcome = {};
  const exit = new RegExp(`${UPGRADE_EXIT_MARKER}=(\\d+)`).exec(text);
  if (exit) outcome.exitCode = Number(exit[1]);
  const fail = /ANYWH fail \S+ \S+ ([^\n]*)/.exec(text);
  if (fail) outcome.failure = fail[1].trim();
  return outcome;
}

/** Whether the installer reported a complete run (its last porcelain line). */
export function installerSucceeded(raw: string): boolean {
  return /ANYWH done ok(\s|$)/m.test(raw.replace(ANSI, ""));
}

/** Conversations to look at: a turn in flight is recent by definition. */
const RECENT_MS = 24 * 60 * 60 * 1000;
const MAX_PROBED = 100;

/** Asks one conversation whether a turn is running: its first `turn_state`. */
async function probeTurn(profile: Profile, sessionId: string, timeoutMs: number): Promise<boolean> {
  const { host, port, token } = await resolveConnection(profile);
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  return new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://${host}:${String(port)}/?session=${encodeURIComponent(sessionId)}${tokenParam}`);
    const finish = (busy: boolean): void => {
      clearTimeout(timer);
      socket.close();
      resolve(busy);
    };
    // No answer in time, or no connection: it cannot be said to be idle,
    // so it counts as running (the caller gives up waiting at some point).
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.addEventListener("message", (event) => {
      let parsed: { type?: unknown; active?: unknown };
      try {
        parsed = JSON.parse(String(event.data)) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type === "turn_state") finish(parsed.active === true);
    });
    socket.addEventListener("error", () => finish(true));
  });
}

/** The ids of this relay's recent conversations that have a turn in flight. */
export async function findBusySessions(profile: Profile, options: { now?: number; probeTimeoutMs?: number } = {}): Promise<string[]> {
  const { host, port, token } = await resolveConnection(profile);
  const sessions = await fetchSessions(host, port, token);
  const now = options.now ?? Date.now();
  const recent = sessions
    .filter((session) => session.lastActiveAt === null || now - session.lastActiveAt < RECENT_MS)
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    .slice(0, MAX_PROBED);
  const busy = await Promise.all(recent.map((session) => probeTurn(profile, session.id, options.probeTimeoutMs ?? 5000)));
  return recent.filter((_, i) => busy[i]).map((session) => session.id);
}

/**
 * Runs `command` in a terminal on the relay's machine and resolves with what
 * it reported. Rejects when the terminal cannot be opened or ends before the
 * command reports (no tmux there, the relay went away), so the caller can
 * fall back to showing the command.
 */
export async function runInRelayTerminal(
  profile: Profile,
  chatSessionId: string,
  command: string,
  options: { timeoutMs?: number; settleMs?: number } = {},
): Promise<UpgradeOutcome & { exitCode: number }> {
  const { host, port, token } = await resolveConnection(profile);
  const params = new URLSearchParams({ session: chatSessionId, term: UPGRADE_TERMINAL_ID, cols: "400", rows: "50" });
  if (token) params.set("token", token);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${String(port)}/terminal?${params.toString()}`);
    let output = "";
    let sent = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const end = (error: Error | null, outcome?: UpgradeOutcome & { exitCode: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settle);
      socket.close();
      if (error) reject(error);
      else if (outcome) resolve(outcome);
    };
    const timer = setTimeout(() => end(new Error("the update did not finish in time")), options.timeoutMs ?? 10 * 60 * 1000);
    // tmux redraws the screen more than once right after attaching, and
    // input typed during that can be swallowed: the command goes once the
    // output has been quiet for a moment.
    const sendWhenQuiet = (): void => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (sent) return;
        sent = true;
        socket.send(JSON.stringify({ type: "input", data: `${command}\r` }));
      }, options.settleMs ?? 400);
    };
    socket.addEventListener("open", sendWhenQuiet);
    socket.addEventListener("message", (event) => {
      let parsed: { type?: unknown; data?: unknown };
      try {
        parsed = JSON.parse(String(event.data)) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type === "exit") return end(new Error("the relay's terminal closed before the update ran"));
      if (parsed.type !== "data" || typeof parsed.data !== "string") return;
      output += parsed.data;
      if (!sent) return sendWhenQuiet();
      const outcome = parseUpgradeOutput(output);
      if (outcome.exitCode !== undefined) end(null, { ...outcome, exitCode: outcome.exitCode });
    });
    socket.addEventListener("close", () => {
      // The restart that ends the update also ends the terminal it ran in,
      // often before the last line gets here: once the installer said it
      // was done, a close is that restart. (The caller still waits for the
      // new version to answer before calling it done.)
      if (sent && installerSucceeded(output)) end(null, { exitCode: 0 });
      else end(new Error("the relay's terminal closed before the update finished"));
    });
  });
}

/** Ends the terminal the update ran in, best effort (it may already be gone). */
export async function closeUpgradeTerminal(profile: Profile, chatSessionId: string): Promise<void> {
  const { host, port, token } = await resolveConnection(profile);
  await fetch(`http://${host}:${String(port)}/terminals/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ session: chatSessionId, term: UPGRADE_TERMINAL_ID }),
  }).catch(() => undefined);
}
