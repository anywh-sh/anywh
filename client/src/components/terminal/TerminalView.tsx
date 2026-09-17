import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { Profile } from "@/lib/profiles/profiles";
import { useResolvedTheme } from "@/hooks/relay/useThemes";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { BrokerRevokedError } from "@/lib/profiles/tailnetBroker";
import { markProfileRevoked } from "@/lib/profiles/profileRevocation";
import { isMacOS } from "@/lib/platform/platform";
import { isNativePasteShortcut, shouldCopySelection } from "@/lib/terminal/terminalKeys";
import { openTerminalLink } from "@/lib/terminal/terminalLinks";
import { useDict } from "@/i18n";

interface TerminalViewProps {
  profile: Profile;
  chatSessionId: string;
  terminalId: string;
  /** Starting directory, honored only the first time this tab's tmux
   * session actually spawns (see `TerminalTab.cwd` in useTerminalTabs.ts). */
  cwd?: string;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Debounce for the `resize` sent to the relay (not for the local `fit()`,
 * which stays immediate so it doesn't visually stutter) — dragging the
 * panel's edge fires the ResizeObserver on every pixel, and every real
 * resize on the pty forces tmux to redraw the whole screen; without this,
 * dragging the edge turns into a flood of full redraws, visibly slow. */
const RESIZE_SEND_DEBOUNCE_MS = 100;

/** Reads the selection out of xterm and into the system clipboard, then drops
 * it — the next Ctrl+C has to reach the shell as SIGINT, which it only does
 * while nothing is selected (see `shouldCopySelection`). */
function copySelectionToClipboard(term: XTerm): void {
  const selection = term.getSelection();
  term.clearSelection();
  navigator.clipboard.writeText(selection).catch((error: unknown) => {
    console.warn("[anywh] failed to copy the terminal selection:", error);
  });
}

function isTerminalMessage(value: unknown): value is { type: "data"; data: string } | { type: "exit"; code: number | null } {
  return typeof value === "object" && value !== null && "type" in value;
}

/**
 * One xterm.js + one WS connection per terminal tab. Single effect that
 * owns the whole lifecycle (xterm instance, socket, observers) — the
 * recommended pattern for integrating an imperative canvas/own-DOM-based
 * library with React, same spirit as `ChatPanel`+`useRelayClient`, except
 * here connection can't be separated from display: xterm needs a real DOM
 * node to attach to.
 *
 * Unmounting (chat session switch, terminal tab closed, panel closed)
 * closes the connection — the relay only detaches from tmux (see
 * terminalSession.ts), so remounting reconnects and the screen reappears
 * the way it was, with no need for any client-side scrollback buffer.
 */
export function TerminalView({ profile, chatSessionId, terminalId, cwd }: TerminalViewProps) {
  const dict = useDict();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  // Literal colors, not CSS variables: xterm takes an object of real color
  // values. Undeclared entries in a custom theme fall back to the built-in
  // ANSI palette but still adopt that theme's own surface and cursor
  // (see themeApply.ts).
  const { terminal: terminalTheme } = useResolvedTheme();
  const themeRef = useRef(terminalTheme);
  themeRef.current = terminalTheme;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      // Limited (not "infinite") on purpose — daily use with several
      // terminal tabs across several sessions can't accumulate memory
      // without bound just because of a forgotten `npm run dev` that's been
      // running for hours.
      scrollback: 5000,
      allowProposedApi: true,
      // A previous attempt used `theme.background: "transparent"` +
      // `allowTransparency` to let whatever sits behind the canvas show
      // through — in practice a visibly different dark rectangle still
      // remained (tested in the real app). Simpler and more robust: instead
      // of chasing real transparency through 2D canvas + WebGL addon + the
      // package's own CSS, paint the terminal with its own solid color
      // (`--bg-chrome`, a shade darker than the dock column it sits in).
      // Read from the resolved theme (a ref, so a theme change doesn't tear
      // down the terminal and its pty — the effect below updates it in
      // place).
      // Bonus: without `allowTransparency`, the canvases go back to not
      // needing an alpha channel, slightly cheaper to composite.
      theme: themeRef.current,
      // OSC 8 hyperlinks (a label carrying a hidden target, emitted by plenty
      // of modern CLIs) don't go through the web-links addon below — they
      // arrive already parsed, and this is the only hook for them. Same
      // handler, so both kinds of link need the same modifier and open the
      // same way. `allowNonHttpProtocols` stays off (the default): an escape
      // sequence printed by any command the shell runs must not be able to
      // name an arbitrary scheme for the OS to launch.
      linkHandler: { activate: openTerminalLink },
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Makes URLs in plain output clickable at all — without this addon xterm
    // never even looks for them. Activation is gated on Ctrl/Cmd inside
    // `openTerminalLink`; the hover underline and pointer cursor the addon
    // draws are not configurable, so they show up regardless of the modifier.
    term.loadAddon(new WebLinksAddon(openTerminalLink));
    term.open(container);
    // Returning `false` makes xterm ignore that keydown entirely: it emits no
    // control character and doesn't cancel the native event, which is what
    // both cases here need — the browser's own paste for Ctrl+V, and a copy
    // instead of SIGINT for Ctrl+C. Everything else falls through unchanged.
    // Why each shortcut qualifies lives with the predicate, in terminalKeys.ts.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (isNativePasteShortcut(event)) return false;
      if (shouldCopySelection(event, term.hasSelection(), isMacOS())) {
        copySelectionToClipboard(term);
        return false;
      }
      return true;
    });
    try {
      // WebGL renderer costs much less CPU than the default canvas one for
      // heavy output (e.g. `npm install`, `cat` of a big file) — important
      // with several terminal tabs open at the same time. Falls back to the
      // default renderer for free (`loadAddon` simply isn't called) if the
      // WebView doesn't support WebGL2, without breaking the terminal.
      term.loadAddon(new WebglAddon());
    } catch (error) {
      console.warn("[anywh] WebGL unavailable for terminal, falling back to default renderer:", error);
    }
    fitAddon.fit();

    let socket: WebSocket | undefined;
    let shouldReconnect = true;
    let reconnectAttempt = 0;
    let reconnectTimer: number | undefined;
    let resizeSendTimer: number | undefined;

    // A tailnet connection needs its own fresh, unspent connect token on
    // every new TCP connection — a reconnect
    // after `close` is a brand-new one, so this resolves again on every
    // call instead of reusing whatever `connect()` used the first time.
    function connect(): void {
      if (!shouldReconnect) return;
      resolveConnection(profile)
        .then(({ host, port, token }) => {
          if (!shouldReconnect) return;
          const params = new URLSearchParams({
            session: chatSessionId,
            term: terminalId,
            cols: String(term.cols),
            rows: String(term.rows),
          });
          if (cwd) params.set("cwd", cwd);
          if (token) params.set("token", token);
          const ws = new WebSocket(`ws://${host}:${String(port)}/terminal?${params.toString()}`);
          socket = ws;

          ws.addEventListener("open", () => {
            reconnectAttempt = 0;
            setReconnecting(false);
          });
          ws.addEventListener("message", (event) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data as string);
            } catch {
              return;
            }
            if (!isTerminalMessage(parsed)) return;
            if (parsed.type === "data") {
              term.write(parsed.data);
            } else if (parsed.type === "exit") {
              term.write(`\r\n\x1b[90m[processo encerrado]\x1b[0m\r\n`);
            }
          });
          ws.addEventListener("close", () => {
            if (socket !== ws) return;
            if (!shouldReconnect) return;
            setReconnecting(true);
            const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
            reconnectAttempt += 1;
            reconnectTimer = window.setTimeout(connect, delay);
          });
        })
        .catch((error: unknown) => {
          console.error("[anywh] failed to resolve a connection for the terminal:", error);
          if (!shouldReconnect) return;
          // Terminal — this device's connection was deliberately revoked and
          // will never succeed again, unlike every other reason this could
          // fail (network blip, relay down), which are worth retrying.
          if (error instanceof BrokerRevokedError) {
            markProfileRevoked(profile.id);
            return;
          }
          setReconnecting(true);
          const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
          reconnectAttempt += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        });
    }
    connect();

    const inputDisposable = term.onData((data) => {
      // Typing drops the selection, the way a native terminal emulator
      // behaves. It also closes the one hole Ctrl+C-copies-selection would
      // otherwise leave: a selection made minutes ago and forgotten, quietly
      // turning the interrupt the user just asked for into a copy.
      if (term.hasSelection()) term.clearSelection();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });

    // Mouse wheel over the terminal: xterm.js's own default for this case
    // (no scrollback on the active buffer — see `scrollTerminal` in the
    // relay's terminalSession.ts for why that's always true here) is to
    // convert wheel deltas into literal Up/Down key presses, mimicking a
    // real xterm for legacy full-screen apps without mouse support. Since
    // every pane here runs inside tmux, that hack lands on tmux's own
    // keystream and gets read as shell history navigation (readline's
    // Up/Down) instead of scrolling — the actual bug report this fixes.
    // Overriding the handler and returning `false` fully suppresses that
    // built-in behavior; the relay's `scrollTerminal` drives tmux's own
    // `copy-mode` instead, which is real pane scrollback with a real
    // "nothing left to scroll" bottom, and (via `copy-mode -e`) auto-exits
    // once back at the bottom.
    const cellHeightPx = (term.options.fontSize ?? 13) * (term.options.lineHeight ?? 1);
    let wheelLineRemainder = 0;
    let pendingScrollLines = 0;
    let scrollFlushRaf: number | undefined;
    const flushScroll = (): void => {
      scrollFlushRaf = undefined;
      if (pendingScrollLines === 0) return;
      const lines = pendingScrollLines;
      pendingScrollLines = 0;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "scroll", lines }));
    };
    term.attachCustomWheelEventHandler((event) => {
      let deltaLines: number;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        deltaLines = -event.deltaY;
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        deltaLines = -event.deltaY * term.rows;
      } else {
        deltaLines = -event.deltaY / cellHeightPx;
      }
      wheelLineRemainder += deltaLines;
      const wholeLines = Math.trunc(wheelLineRemainder);
      if (wholeLines !== 0) {
        wheelLineRemainder -= wholeLines;
        pendingScrollLines += wholeLines;
        if (scrollFlushRaf === undefined) scrollFlushRaf = requestAnimationFrame(flushScroll);
      }
      return false;
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.clearTimeout(resizeSendTimer);
      resizeSendTimer = window.setTimeout(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      }, RESIZE_SEND_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    return () => {
      shouldReconnect = false;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(resizeSendTimer);
      if (scrollFlushRaf !== undefined) cancelAnimationFrame(scrollFlushRaf);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      socket?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [
    profile.host,
    profile.relayPort,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
    chatSessionId,
    terminalId,
    cwd,
  ]);

  // Live theme swap. Assigning `options.theme` repaints the existing
  // instance, so switching theme keeps the scrollback and the pty — which
  // remounting the terminal would not.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme;
  }, [terminalTheme]);

  return (
    // `--terminal-bg` feeds the `.xterm-viewport` override in index.css:
    // the package's own CSS forces a solid black viewport behind the
    // canvas, and it has to be the same color the terminal paints, which is
    // the theme's own terminal background whenever a theme declares one.
    <div className="relative h-full w-full" style={{ "--terminal-bg": terminalTheme.background } as React.CSSProperties}>
      <div ref={containerRef} className="selectable-content h-full w-full p-2" />
      {reconnecting && (
        <div className="absolute top-2 right-2 border border-border bg-bg-elevated px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          {dict.panels.terminal.reconnecting}
        </div>
      )}
    </div>
  );
}
