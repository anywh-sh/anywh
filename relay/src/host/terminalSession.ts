import { execFile } from "node:child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

// Embedded terminal — reuses the same ttyd+tmux pair already
// validated in this project, just without ttyd: the relay is
// already a persistent WS server, so it spawns tmux directly via node-pty
// (`sudo` inside the terminal needs a real TTY for the password prompt — a
// child_process without a PTY won't do). tmux is what guarantees genuine
// persistence: closing the WS connection just sends SIGHUP to the local
// process (which tmux treats as a *detach*, not as killing the session —
// same behavior as closing a real terminal with tmux inside), and a relay
// restart (e.g. deploying new code) doesn't bring down the open shells,
// because the tmux server runs independently of the relay process. The
// relay keeps no in-memory record of which terminal is alive — tmux is the
// source of truth, queried on demand (list-sessions) when needed.
const TMUX_BIN = process.env.TMUX_BIN ?? "/usr/bin/tmux";

/** A dedicated tmux socket per relay instance (== per profile, since each
 * profile runs its own relay process on its own port) — without this, the
 * two profiles (personal/work, same Unix user) would collide on tmux's
 * default socket (`/tmp/tmux-<uid>/default`), which knows nothing about a
 * `HOME` override. */
export function tmuxSocketName(relayPort: number): string {
  return `anywh-term-${relayPort}`;
}

/** IDs come from outside (WS connection query string) — never interpolated
 * into a shell (both `pty.spawn` and `execFile` receive argv as an array,
 * not a string for a shell to parse), but `:`/`.` have special meaning in
 * tmux's "target" syntax (session:window.pane) even outside any shell, so
 * sanitize just in case even though the IDs are UUIDs in practice. */
export function sanitizeId(id: string): string {
  return id.replace(/[:.]/g, "_");
}

export function tmuxSessionName(chatSessionId: string, terminalId: string): string {
  return `${sanitizeId(chatSessionId)}__${sanitizeId(terminalId)}`;
}

/** Every tmux session name for a chat session's terminals shares this
 * prefix (see `tmuxSessionName`) — what `killAllTerminalsForSession` below
 * filters `list-sessions` output against. */
export function sessionNamePrefix(chatSessionId: string): string {
  return `${sanitizeId(chatSessionId)}__`;
}

export interface SpawnTerminalOptions {
  /** Built by the caller (server.ts) via `host/childEnv.ts`'s
   * `buildChildEnv` — this file takes it as plain data instead of importing
   * from `runtimes/` to build it itself. */
  env: NodeJS.ProcessEnv;
  relayPort: number;
  chatSessionId: string;
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
}

/** Spawns (or reattaches to, via `-A`) this terminal tab's tmux session.
 * `-c` only has an effect on creation — reattaching to an existing session
 * ignores `cwd` on purpose (that's normal terminal behavior: an
 * already-running shell's folder doesn't teleport if the conversation's
 * working directory changes later; whoever wants another folder does `cd`
 * by hand or opens a new tab).
 *
 * `-f /dev/null` is essential, not cosmetic: an isolated socket (`-L`) only
 * separates *sessions* — tmux still loads the real `~/.tmux.conf` for ANY
 * new server that comes up, regardless of socket. Without `-f /dev/null`, a
 * `mouse on` (or anything else) in the user's personal config leaked into
 * the embedded terminal — that's what caused tmux's `[0/0]` copy-mode
 * indicator to show up when selecting text with the mouse (finding from
 * testing).
 *
 * The chained `; set-option ...` (literal `;` token — no shell in between,
 * `pty.spawn` receives raw argv, so it's not shell syntax, it's tmux itself
 * recognizing `;` as a command separator) locks in the behavior we want,
 * without depending on any config: `status off` (otherwise a "junk" line
 * shows up with truncated session id + hostname + time, tmux chrome
 * duplicating the app's tab strip) and explicit `mouse off` (already
 * tmux's default without a config, but documented here — it's what
 * guarantees text selection is always xterm.js-native, never tmux's
 * copy-mode). `-g` (global, not per-session) guarantees this holds both
 * when creating and when reattaching: an explicit `-t <name>` would only
 * take effect on creation, like `-c` above. */
export function spawnTerminal(options: SpawnTerminalOptions): IPty {
  const socket = tmuxSocketName(options.relayPort);
  const name = tmuxSessionName(options.chatSessionId, options.terminalId);

  return pty.spawn(
    TMUX_BIN,
    [
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-A",
      "-s",
      name,
      "-c",
      options.cwd,
      ";",
      "set-option",
      "-g",
      "status",
      "off",
      ";",
      "set-option",
      "-g",
      "mouse",
      "off",
    ],
    {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    },
  );
}

function execTmux(relayPort: number, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, ["-L", tmuxSocketName(relayPort), ...args], (error, stdout) => {
      // Errors here are expected and non-critical (session no longer
      // existed, or the tmux socket never came to exist because no
      // terminal was opened yet in this profile) — never becomes an
      // exception for the caller.
      resolve(error ? "" : stdout);
    });
  });
}

/** Genuinely closes a specific terminal tab (kills the tmux session, not
 * just a detach) — called when the user clicks a tab's X, unlike switching
 * chat sessions or closing the panel (which only detach, see comment at
 * the top of the file). */
export function killTerminal(relayPort: number, chatSessionId: string, terminalId: string): Promise<void> {
  return execTmux(relayPort, ["kill-session", "-t", tmuxSessionName(chatSessionId, terminalId)]).then(() => undefined);
}

/** Scrolls a terminal pane's content via tmux's own `copy-mode`, instead of
 * relying on xterm.js's normal-buffer scrollback (there is none: tmux keeps
 * the outer terminal permanently on the alternate screen buffer for as long
 * as it's attached, regardless of what runs inside the pane, so
 * `buffer.hasScrollback` is always false from xterm.js's point of view). Two
 * chained tmux commands (see the `spawnTerminal` comment above for why a
 * literal `;` argv token works without a shell in between): `copy-mode -e`
 * enters copy mode (a safe no-op if the pane is already in it) with the same
 * `-e` tmux's own default mouse binding uses, so scrolling back down past
 * the bottom auto-exits copy mode instead of getting the pane stuck in it;
 * `send-keys -X -N <n> scroll-up/down` then moves the view by exactly `n`
 * lines. Deliberately not `set-option mouse on` (see `spawnTerminal`
 * comment) — that would hand xterm.js's whole mouse handling to tmux and
 * break native click-drag text selection, the opposite of the direct
 * scroll-only path here (driven by the client's own wheel handler, see
 * `TerminalView.tsx`). */
export function scrollTerminal(relayPort: number, chatSessionId: string, terminalId: string, lines: number): Promise<void> {
  if (lines === 0) return Promise.resolve();
  const target = tmuxSessionName(chatSessionId, terminalId);
  return execTmux(relayPort, [
    "copy-mode",
    "-e",
    "-t",
    target,
    ";",
    "send-keys",
    "-X",
    "-t",
    target,
    "-N",
    String(Math.abs(lines)),
    lines > 0 ? "scroll-up" : "scroll-down",
  ]).then(() => undefined);
}

/** Prefix sweep (doesn't depend on any in-memory record of the relay) —
 * called when deleting an entire chat session, so no orphaned shells keep
 * running forever with no tab controlling them. */
export async function killAllTerminalsForSession(relayPort: number, chatSessionId: string): Promise<void> {
  const stdout = await execTmux(relayPort, ["list-sessions", "-F", "#{session_name}"]);
  const prefix = sessionNamePrefix(chatSessionId);
  const names = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith(prefix));
  await Promise.all(names.map((name) => execTmux(relayPort, ["kill-session", "-t", name])));
}
