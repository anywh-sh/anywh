import { useEffect, useRef, useState, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink } from "lucide-react";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";
import { openAgentLogin, type AgentLoginErrorReason, type AgentLoginFrame } from "@/lib/relay/relayClient";
import { trackError, trackFeature } from "@/lib/telemetry/instrument";

export interface AgentLoginTarget {
  /** The profile whose machine — and so whose account — the sign-in is for. */
  profile: Profile;
  runtimeId: string;
  /** A profile being created, signed in through `profile`'s relay before
   * the new profile's own relay exists: its draft id (its own config
   * folders), or a legacy custom home. */
  draftId?: string;
  home?: string;
}

interface AgentLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AgentLoginTarget | null;
  /** Once the agent reports an account. The dialog stays open on "Connected"
   * until the person closes it. */
  onSignedIn?: (target: AgentLoginTarget) => void;
}

/** How long the dialog waits for a prompt before showing the CLI's own
 * output instead: a CLI that changed how it prints its link still gets the
 * person signed in, just less tidily. */
const RAW_OUTPUT_AFTER_MS = 8000;

type Prompt = Extract<AgentLoginFrame, { type: "prompt" }>;

export type AgentLoginState =
  | { step: "connecting"; output: string; showOutput: boolean }
  /** `invalid`: the last code was malformed; the login goes on. */
  | { step: "prompt"; prompt: Prompt; checking: boolean; invalid?: boolean }
  | { step: "done"; account?: string }
  | { step: "rejected"; detail?: string }
  | { step: "error"; reason: AgentLoginErrorReason | "unreachable"; detail?: string };

/** Pure: the next state for one frame from the relay. */
export function reduceAgentLogin(state: AgentLoginState, frame: AgentLoginFrame): AgentLoginState {
  switch (frame.type) {
    case "output":
      return state.step === "connecting" ? { ...state, output: state.output + frame.data } : state;
    case "prompt":
      return { step: "prompt", prompt: frame, checking: false };
    case "invalid-code":
      return state.step === "prompt" ? { ...state, checking: false, invalid: true } : state;
    case "done":
      return frame.account ? { step: "done", account: frame.account } : { step: "done" };
    case "rejected":
      return frame.detail ? { step: "rejected", detail: frame.detail } : { step: "rejected" };
    case "error":
      return frame.detail ? { step: "error", reason: frame.reason, detail: frame.detail } : { step: "error", reason: frame.reason };
  }
}

/** A device code the link already carries is there to compare, not type. */
export function codeIsInLink(prompt: Prompt): boolean {
  return prompt.userCode !== undefined && prompt.url.includes(prompt.userCode);
}

/** Opens the sign-in page in the system browser. Where the opener plugin
 * isn't there (the app served to a plain browser) the browser opens it. */
function openSignInPage(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault();
  openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

const INITIAL: AgentLoginState = { step: "connecting", output: "", showOutput: false };

/**
 * Signs an agent's account in on a profile's machine, from the app.
 *
 * The same three steps for every agent: open the provider's own sign-in
 * page (on this device — the relay never opens one on the host), then do
 * the one thing that provider asks — paste back a code (Claude), type a
 * code into the page (Codex), or only approve (Kimi) — then "Connected".
 * The relay runs the CLI's own sign-in; the pasted code goes straight to
 * it and the credential it ends in stays in the CLI's own store.
 */
export function AgentLoginDialog({ open, onOpenChange, target, onSignedIn }: AgentLoginDialogProps) {
  const dict = useDict();
  const copy = dict.shell.profiles.agentLogin;
  const [state, setState] = useState<AgentLoginState>(INITIAL);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  // The login is keyed by what it signs in, not by the target object's
  // identity: a caller that builds the target inline must not restart the
  // sign-in on every render.
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = target ? `${target.profile.id}\0${target.runtimeId}\0${target.draftId ?? ""}\0${target.home ?? ""}` : null;

  const agent = target ? agentName(dict.chat.composer.agentNames, target.runtimeId) : "";
  const fill = (text: string): string => text.split("{agent}").join(agent);

  // One socket per open dialog (and per "Start over"); closing the dialog
  // closes it, which ends the login on the relay.
  useEffect(() => {
    const target = targetRef.current;
    if (!open || !target) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    setState(INITIAL);
    setCode("");
    const rawTimer = window.setTimeout(() => {
      setState((previous) => (previous.step === "connecting" ? { ...previous, showOutput: true } : previous));
    }, RAW_OUTPUT_AFTER_MS);

    openAgentLogin(target.profile, target.runtimeId, { draftId: target.draftId, home: target.home }).then(
      (opened) => {
        if (cancelled) {
          opened.close();
          return;
        }
        socket = opened;
        socketRef.current = opened;
        let ended = false;
        opened.onmessage = (event) => {
          const frame = JSON.parse(String(event.data)) as AgentLoginFrame;
          if (frame.type === "done" || frame.type === "rejected" || frame.type === "error") ended = true;
          if (frame.type === "done") {
            trackFeature("agent_signin");
            onSignedInRef.current?.(target);
          } else if (frame.type === "error" && frame.reason !== "superseded") {
            trackError("agent_signin_failed");
          }
          setState((previous) => reduceAgentLogin(previous, frame));
        };
        opened.onclose = () => {
          if (socketRef.current === opened) socketRef.current = null;
          if (!ended && !cancelled) setState({ step: "error", reason: "unreachable" });
        };
      },
      () => {
        if (!cancelled) setState({ step: "error", reason: "unreachable" });
      },
    );

    return () => {
      cancelled = true;
      window.clearTimeout(rawTimer);
      socket?.close();
      socketRef.current = null;
    };
  }, [open, targetKey, attempt]);

  function submit(): void {
    const socket = socketRef.current;
    const value = code.trim();
    if (!socket || socket.readyState !== socket.OPEN || value.length === 0) return;
    socket.send(JSON.stringify({ type: "code", value }));
    setState((previous) => (previous.step === "prompt" ? { ...previous, checking: true } : previous));
  }

  function copyText(kind: "link" | "code", text: string): void {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1500);
    });
  }

  const finished = state.step === "done";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{fill(copy.title)}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          {state.step === "connecting" && (
            <div className="flex flex-col gap-2">
              <p role="status" className="flex items-center gap-2 text-xs text-text-faint">
                <Spinner size="md" />
                {copy.connecting}
              </p>
              {state.showOutput && state.output.length > 0 && (
                <>
                  <p className="text-xs text-muted-foreground">{copy.rawOutput}</p>
                  <pre className="selectable-content max-h-48 overflow-y-auto border border-border/60 bg-bg-chrome p-2.5 font-mono text-[11px] break-all whitespace-pre-wrap text-foreground">
                    {state.output}
                  </pre>
                </>
              )}
            </div>
          )}

          {state.step === "prompt" && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Button asChild size="sm">
                  <a href={state.prompt.url} target="_blank" rel="noreferrer" onClick={(event) => openSignInPage(event, state.prompt.url)}>
                    <ExternalLink aria-hidden="true" />
                    {copy.openPage}
                  </a>
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => copyText("link", state.prompt.url)}>
                  {copied === "link" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "link" ? copy.copied : copy.copyLink}
                </Button>
              </div>

              {state.prompt.input === "code" ? (
                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                  }}
                >
                  <label htmlFor="agent-login-code" className="text-xs text-muted-foreground">
                    {copy.pasteLabel}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="agent-login-code"
                      className="flex-1 font-mono"
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value);
                        setState((previous) => (previous.step === "prompt" && previous.invalid ? { ...previous, invalid: false } : previous));
                      }}
                      aria-invalid={state.invalid ?? false}
                      aria-describedby={state.invalid ? "agent-login-code-invalid" : undefined}
                      placeholder={copy.pastePlaceholder}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={state.checking}
                    />
                    <Button type="submit" size="sm" loading={state.checking} disabled={code.trim().length === 0}>
                      {copy.submit}
                    </Button>
                  </div>
                  {state.invalid && (
                    <p id="agent-login-code-invalid" role="alert" className="text-xs text-destructive">
                      {copy.invalidCode}
                    </p>
                  )}
                </form>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {state.prompt.userCode !== undefined && (
                    <>
                      <p className="text-xs text-muted-foreground">{codeIsInLink(state.prompt) ? copy.checkCode : copy.enterCode}</p>
                      <div className="flex items-center gap-2">
                        <code data-agent-login-code className="selectable-content border border-border bg-bg-chrome px-3 py-1.5 font-mono text-lg tracking-[0.15em] text-foreground">
                          {state.prompt.userCode}
                        </code>
                        <Button type="button" size="sm" variant="ghost" onClick={() => copyText("code", state.prompt.userCode ?? "")}>
                          {copied === "code" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                          {copied === "code" ? copy.copied : copy.copyCode}
                        </Button>
                      </div>
                    </>
                  )}
                  <p className="flex items-center gap-2 text-xs text-text-faint">
                    <Spinner size="md" />
                    {copy.waiting}
                  </p>
                </div>
              )}
            </div>
          )}

          {state.step === "done" && (
            <div role="status" className="flex items-center gap-3 border border-border bg-bg-chrome px-3 py-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-diff-add/15">
                <Check aria-hidden="true" className="size-4 text-diff-add" />
              </span>
              <span className="text-sm font-medium text-foreground">
                {state.account ? copy.signedInAs.replace("{account}", state.account) : copy.signedIn}
              </span>
            </div>
          )}

          {state.step === "rejected" && (
            <div role="alert" className="flex flex-col gap-1">
              <p className="text-sm text-foreground">{copy.rejected}</p>
            </div>
          )}

          {state.step === "error" && (
            <div role="alert" className="flex flex-col gap-1">
              <p className="text-sm text-foreground">{fill(errorText(state.reason, copy))}</p>
              {state.detail && <p className="font-mono text-[11px] break-words text-text-faint">{state.detail}</p>}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {(state.step === "rejected" || (state.step === "error" && state.reason !== "superseded")) && (
            <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {copy.tryAgain}
            </Button>
          )}
          <Button type="button" size="sm" variant={finished ? "default" : "outline"} onClick={() => onOpenChange(false)}>
            {finished ? copy.done : copy.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function errorText(reason: AgentLoginErrorReason | "unreachable", copy: ReturnType<typeof useDict>["shell"]["profiles"]["agentLogin"]): string {
  switch (reason) {
    case "superseded":
      return copy.superseded;
    case "failed":
      return copy.failed;
    case "not-signed-in":
      return copy.notSignedIn;
    case "unreachable":
      return copy.unreachable;
    case "unknown-runtime":
    case "unsupported":
    case "bad-home":
    case "unknown-profile":
    case "start-failed":
      return copy.startFailed;
  }
}
