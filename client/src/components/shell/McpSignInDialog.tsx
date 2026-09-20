import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import { openMcpLogin } from "@/lib/relay/relayClient";
import { stripAnsi } from "@/lib/text/ansi";

export interface McpSignInTarget {
  /** The relay that will run the login — the same host the profile lives
   * on, since an MCP session is written into a config home on disk. */
  host: string;
  port: number;
  runtimeId: string;
  /** The config home to sign in under. A new profile's, not the active
   * one's: signing in to the wrong home is the failure this parameter
   * exists to make impossible to fall into by default. */
  home?: string;
  servers: string[];
}

interface McpSignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: McpSignInTarget | null;
}

type LoginState = { status: "idle" } | { status: "running"; output: string } | { status: "done"; output: string; code: number | null };

/**
 * Signs in to the MCP servers a carried setup brought along.
 *
 * The declarations travel with a bundle; the sessions can't, and are
 * re-earned here — the same posture as the agent account itself. What this
 * component does is drive the CLI's own `mcp login` over a socket and show
 * what it prints. It never parses that output, and the token it ends in is
 * written by the CLI into its own store; nothing about it passes through
 * the client.
 *
 * On a headless machine the flow is: the CLI prints an authorization URL,
 * the user opens it wherever they have a browser, and pastes the address
 * they land on back into the field below.
 */
export function McpSignInDialog({ open, onOpenChange, target }: McpSignInDialogProps) {
  const copy = useDict().shell.profiles.mcpSignIn;
  const [active, setActive] = useState<string | null>(null);
  const [state, setState] = useState<LoginState>({ status: "idle" });
  const [pasted, setPasted] = useState("");
  const socketRef = useRef<WebSocket | null>(null);

  // A login left running holds a callback listener on the host that
  // nobody is going to reach — closing the socket is what ends it (the
  // relay kills the child on close).
  useEffect(() => {
    if (open) return;
    socketRef.current?.close();
    socketRef.current = null;
    setActive(null);
    setState({ status: "idle" });
    setPasted("");
  }, [open]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  function startLogin(serverName: string): void {
    if (!target) return;
    socketRef.current?.close();
    setActive(serverName);
    setPasted("");
    setState({ status: "running", output: "" });
    const socket = openMcpLogin(target.host, target.port, target.runtimeId, serverName, target.home);
    socketRef.current = socket;
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; data?: string; code?: number | null; error?: string };
      setState((previous) => {
        const output = previous.status === "idle" ? "" : previous.output;
        // Stripped here rather than relay-side: what crosses the socket
        // stays exactly what the CLI wrote, and the one consumer that
        // renders it in plain DOM is the one that has to cope with it
        // being terminal output.
        if (frame.type === "data") return { status: "running", output: output + stripAnsi(frame.data ?? "") };
        if (frame.type === "error") return { status: "done", output: `${output}${frame.error ?? ""}`, code: 1 };
        if (frame.type === "exit") return { status: "done", output, code: frame.code ?? null };
        return previous;
      });
    };
    socket.onclose = () => {
      socketRef.current = null;
    };
  }

  function send(): void {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== socket.OPEN || pasted.trim().length === 0) return;
    // A trailing carriage return, because what's on the other end is a CLI
    // reading a line — without it the CLI simply keeps waiting.
    socket.send(JSON.stringify({ type: "input", data: `${pasted.trim()}\r` }));
    setPasted("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <DialogDescription>{copy.description}</DialogDescription>

          <div className="flex flex-col gap-1.5">
            {(target?.servers ?? []).map((serverName) => (
              <div key={serverName} className="flex items-center gap-3 border border-border/60 px-3 py-2">
                <span className="flex-1 truncate font-mono text-xs text-foreground">{serverName}</span>
                {active === serverName && state.status === "done" ? (
                  <span className="text-xs text-text-faint">{state.code === 0 ? copy.signedIn : copy.failed}</span>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={active === serverName} onClick={() => startLogin(serverName)}>
                    {active === serverName ? copy.working : copy.signIn}
                  </Button>
                )}
              </div>
            ))}
          </div>

          {active && state.status !== "idle" && (
            <div className="flex flex-col gap-2">
              <pre className="max-h-48 overflow-y-auto border border-border/60 bg-bg-chrome p-2.5 font-mono text-[11px] break-all whitespace-pre-wrap text-foreground">
                {state.output}
              </pre>
              {state.status === "running" && (
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    placeholder={copy.pastePlaceholder}
                    aria-label={copy.pastePlaceholder}
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") send();
                    }}
                  />
                  <Button type="button" size="sm" variant="outline" onClick={send}>
                    {copy.send}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
