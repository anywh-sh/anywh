import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AgentMark } from "@/components/shell/AgentMark";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { siteHost } from "@/lib/integrations/derive";
import { useDict } from "@/i18n";
import type { Dictionary } from "@/i18n/dictionary";
import { checkCallbackPaste, connectProgress, connectRows, CONNECT_RUNTIMES, flowErrorKey, isActiveFlow, pendingTargets, type CallbackPasteError, type ConnectRow } from "@/lib/integrations/connect";
import type { IntegrationProvider, IntegrationsClientMessage, McpAuthFlow, McpRuntimeId } from "@/lib/integrations/model";
import type { Profile } from "@/lib/profiles/profiles";
import { getHostInfo } from "@/lib/relay/filesClient";
import { cn } from "@/lib/utils";

interface ConnectCardProps {
  profile: Profile;
  /** The integration to connect; `null` keeps the card closed. */
  integrationId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Adds an integration's MCP server to a profile's agents and signs them in,
 * one agent per line — the "+" opens it as much as the integration's pane
 * does. "Add" declares the server in an agent that lacks it (the relay then
 * starts its sign-in, which the line follows); "Connect" starts the agent CLI's own OAuth flow on the relay, which
 * then reports it (`mcp_auth_flow`) as it goes — the browser opens, the app
 * gets the `anywh://` callback back (routed by `oauthDeepLink.ts`), the relay
 * finishes. Several agents at once are one queue on the relay ("Connect
 * all", which adds the server where it is missing too), signed in one after
 * the other.
 *
 * When the browser cannot come back to the app (another device, a server
 * that refuses the app's link), "Open on another device" restarts the flow
 * in the relay's `localhost` mode: copy the link, sign in anywhere, paste
 * the address the browser ended on. A claude.ai connector is authorized on
 * claude.ai itself, and the relay is asked to look again on return.
 */
export function ConnectCard({ profile, integrationId, onOpenChange }: ConnectCardProps) {
  const dict = useDict();
  const copy = dict.integrations.connect;
  const integrations = useProfileIntegrations(profile.id);
  const open = integrationId !== null;
  const [installed, setInstalled] = useState<McpRuntimeId[] | null>(null);
  /** The machine could not say which agents it has. */
  const [hostUnknown, setHostUnknown] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  /** Agents whose sign-in was moved to another device: their browser is not
   * opened here. */
  const [elsewhere, setElsewhere] = useState<ReadonlySet<McpRuntimeId>>(new Set());
  const openedFlows = useRef(new Set<string>());
  /** claude.ai rechecks asked from here, by flow, with the flow as it was
   * when asked: the relay reports no "checking" state of its own, so the
   * row is busy until the flow comes back with an answer. */
  const [rechecks, setRechecks] = useState<Readonly<Record<string, McpAuthFlow>>>({});
  const recheckTimers = useRef(new Set<number>());
  useEffect(() => {
    const timers = recheckTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setUnreachable(false);
    setElsewhere(new Set());
    setInstalled(null);
    setHostUnknown(false);
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (cancelled) return;
        const ids = new Set((info.agents ?? []).map((agent) => agent.id));
        const found = CONNECT_RUNTIMES.filter((id) => ids.has(id));
        if (found.length > 0) setInstalled(found);
        else setHostUnknown(true);
      })
      .catch(() => {
        if (!cancelled) setHostUnknown(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, profile]);

  const entry = integrations?.entry;
  const integration = entry?.integrations?.find((item) => item.id === integrationId);
  const flows = entry?.authFlows ?? {};
  // A machine that cannot say which agents it has is offered the
  // integration in every one of them.
  const listed = installed ?? (hostUnknown ? CONNECT_RUNTIMES : null);
  const rows = connectRows(integration, flows, listed);
  const loading = installed === null && !hostUnknown;

  // A sign-in that reaches the browser step opens the browser once, unless
  // it was moved to another device.
  useEffect(() => {
    if (!open) return;
    for (const row of rows) {
      const flow = row.flow;
      if (!flow || flow.phase !== "awaiting_user" || !flow.authUrl || flow.mode === "localhost" || elsewhere.has(row.runtimeId)) continue;
      if (openedFlows.current.has(flow.flowId)) continue;
      openedFlows.current.add(flow.flowId);
      void openUrl(flow.authUrl).catch(() => {});
    }
  });

  // A claude.ai connector is authorized in another window: coming back to
  // this one is the moment to look again.
  const waitingClaudeai = rows.map((row) => row.flow).filter((flow): flow is McpAuthFlow => flow?.phase === "awaiting_user" && flow.mode === "claudeai");
  const claudeaiKey = waitingClaudeai.map((flow) => flow.flowId).join(",");
  const sendRef = useRef(integrations?.send);
  sendRef.current = integrations?.send;
  const askRecheck = (flowId: string): boolean => {
    const flow = flows[flowId] as McpAuthFlow | undefined;
    if (!flow || !sendRef.current?.({ type: "mcp_auth_recheck", flowId })) return false;
    setRechecks((prev) => ({ ...prev, [flowId]: flow }));
    // A recheck the relay turned down sends nothing back: stop waiting
    // after its window.
    const timer = window.setTimeout(() => {
      recheckTimers.current.delete(timer);
      setRechecks((prev) => {
        if (prev[flowId] !== flow) return prev;
        const { [flowId]: _gone, ...rest } = prev;
        return rest;
      });
    }, RECHECK_WAIT_MS);
    recheckTimers.current.add(timer);
    return true;
  };
  const askRecheckRef = useRef(askRecheck);
  askRecheckRef.current = askRecheck;
  useEffect(() => {
    if (!open || claudeaiKey === "") return;
    const ids = claudeaiKey.split(",");
    const onFocus = () => {
      for (const flowId of ids) askRecheckRef.current(flowId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, claudeaiKey]);

  if (!integrationId) return null;
  const provider: IntegrationProvider = integration?.provider ?? (integrationId === "linear" ? "linear" : "jira");
  const name = dict.integrations.providers[provider];
  const host = siteHost(integration);
  const progress = connectProgress(rows);
  const queue = pendingTargets(rows);
  const missing = rows.filter((row) => row.state === "missing").map((row) => row.runtimeId);
  const batch = queue.length + missing.length;

  const send = (message: IntegrationsClientMessage): boolean => {
    const sent = integrations?.send(message) ?? false;
    setUnreachable(!sent);
    return sent;
  };
  const elsewhereFor = (runtimeId: McpRuntimeId, value: boolean) =>
    setElsewhere((prev) => {
      const next = new Set(prev);
      if (value) next.add(runtimeId);
      else next.delete(runtimeId);
      return next;
    });

  const actions: RowActions = {
    connect: (row) => {
      if (!row.runtime) return;
      elsewhereFor(row.runtimeId, false);
      send({ type: "mcp_auth_start", targets: [{ runtimeId: row.runtimeId, serverName: row.runtime.serverName }] });
    },
    add: (row) => send({ type: "integration_add", id: integrationId, provider, runtimes: [row.runtimeId] }),
    cancel: (flow) => send({ type: "mcp_auth_cancel", flowId: flow.flowId }),
    anotherDevice: (row, flow) => {
      if (!row.runtime) return;
      elsewhereFor(row.runtimeId, true);
      if (isActiveFlow(flow)) send({ type: "mcp_auth_cancel", flowId: flow.flowId });
      send({ type: "mcp_auth_start", targets: [{ runtimeId: row.runtimeId, serverName: row.runtime.serverName }], mode: "localhost" });
    },
    complete: (flow, url) => send({ type: "mcp_auth_complete", flowId: flow.flowId, callbackUrl: url }),
    recheck: (flow) => setUnreachable(!askRecheck(flow.flowId)),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" aria-describedby={undefined} data-testid="connect-card">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground">
              <IntegrationIcon provider={provider} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle>{copy.title.replace("{name}", name)}</DialogTitle>
              <DialogDescription className="truncate font-mono text-[11px] text-text-faint">{[profile.label, host].filter(Boolean).join(" · ")}</DialogDescription>
            </div>
            {progress.total > 0 && (
              <span data-testid="connect-progress" className="shrink-0 font-mono text-[11px] text-text-faint">
                {copy.progress.replace("{connected}", String(progress.connected)).replace("{total}", String(progress.total))}
              </span>
            )}
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {rows.length === 0 && !loading && <p className="px-4 py-4 text-sm text-muted-foreground">{copy.noAgents.replace("{name}", name)}</p>}
          {rows.map((row) => (
            <ConnectRowView key={row.runtimeId} row={row} name={name} host={host} elsewhere={elsewhere.has(row.runtimeId)} rechecking={row.flow ? isRechecking(row.flow, rechecks[row.flow.flowId]) : false} actions={actions} />
          ))}
        </div>
        {(batch > 1 || unreachable) && (
          <div className="flex items-center gap-3 border-t border-border px-4 py-3">
            {unreachable && <p className="min-w-0 flex-1 text-xs text-destructive">{copy.unreachable}</p>}
            {batch > 1 && (
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  // The relay signs the added servers in itself, after the
                  // ones already there.
                  if (queue.length > 0 && !send({ type: "mcp_auth_start", targets: queue })) return;
                  if (missing.length > 0) send({ type: "integration_add", id: integrationId, provider, runtimes: missing });
                }}
              >
                {copy.connectAll}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** How long a recheck asked from here may go unanswered: the relay's own
 * window, with room to spare. */
const RECHECK_WAIT_MS = 150_000;

/** Whether the relay is still looking on claude.ai for `flow`, asked as
 * `asked`: nothing came back yet, or what came back is the recheck starting
 * (an awaiting flow with no error) rather than its answer. */
function isRechecking(flow: McpAuthFlow, asked: McpAuthFlow | undefined): boolean {
  if (!asked || flow.mode !== "claudeai" || flow.phase !== "awaiting_user") return false;
  return flow === asked || flow.error === undefined;
}

/** A sign-in's reported reason in the person's language. The raw text
 * (a CLI's own message, say) is only ever a tooltip. */
function flowErrorText(copy: Dictionary["integrations"]["connect"], error: string): string {
  const key = flowErrorKey(error);
  return key === "not_url" || key === "missing_code" || key === "state_mismatch" ? copy.pasteErrors[key] : copy.flowErrors[key];
}

function FlowError({ error }: { error: string | undefined }) {
  const copy = useDict().integrations.connect;
  if (!error) return null;
  return (
    <p data-testid="connect-flow-error" title={error} className="text-xs text-destructive">
      {flowErrorText(copy, error)}
    </p>
  );
}

interface RowActions {
  connect: (row: ConnectRow) => void;
  add: (row: ConnectRow) => void;
  cancel: (flow: McpAuthFlow) => void;
  anotherDevice: (row: ConnectRow, flow: McpAuthFlow) => void;
  complete: (flow: McpAuthFlow, url: string) => void;
  recheck: (flow: McpAuthFlow) => void;
}

function ConnectRowView({ row, name, host, elsewhere, rechecking, actions }: { row: ConnectRow; name: string; host: string | null; elsewhere: boolean; rechecking: boolean; actions: RowActions }) {
  const dict = useDict();
  const copy = dict.integrations.connect;
  const agent = dict.chat.composer.agentNames[row.runtimeId];
  const flow = row.flow;
  /** The app's link did not come back: the address goes in by hand. */
  const [pasting, setPasting] = useState(false);

  let status: { text: string; tone?: "ok" | "error" };
  let trailing: ReactNode = null;
  let body: ReactNode = null;

  if (flow && isActiveFlow(flow)) {
    if (flow.phase === "queued") {
      status = { text: copy.queued };
      trailing = <Button type="button" size="sm" variant="ghost" onClick={() => actions.cancel(flow)}>{copy.cancel}</Button>;
    } else if (flow.phase === "completing") {
      status = { text: copy.completing };
      trailing = <Spinner />;
    } else if (flow.mode === "claudeai") {
      status = { text: rechecking ? copy.rechecking : copy.claudeai };
      if (rechecking) trailing = <Spinner />;
      body = (
        <>
          <p className="text-xs text-muted-foreground">{copy.claudeaiHint}</p>
          {!rechecking && <FlowError error={flow.error} />}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={rechecking} onClick={() => actions.recheck(flow)}>
              {copy.recheck}
            </Button>
            {flow.authUrl && (
              <Button type="button" size="sm" variant="outline" onClick={() => void openUrl(flow.authUrl!).catch(() => {})}>
                {copy.openClaudeai}
                <ExternalLink className="size-3" />
              </Button>
            )}
            <TextAction onClick={() => actions.cancel(flow)}>{copy.cancel}</TextAction>
          </div>
        </>
      );
    } else if (flow.mode === "localhost") {
      status = { text: elsewhere ? copy.elsewhere : copy.paste };
      body = (
        <>
          <FlowError error={flow.error} />
          <PasteForm flow={flow} hint={copy.pasteHint} placeholder={copy.pastePlaceholder} withLinkRow onComplete={(url) => actions.complete(flow, url)} onCancel={() => actions.cancel(flow)} />
        </>
      );
    } else {
      status = { text: copy.awaiting };
      trailing = <Spinner />;
      body = (
        <>
          <FlowError error={flow.error} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {flow.authUrl && <TextAction onClick={() => void openUrl(flow.authUrl!).catch(() => {})}>{copy.reopen}</TextAction>}
            {flow.authUrl && <CopyLink url={flow.authUrl} />}
            {!pasting && <TextAction onClick={() => setPasting(true)}>{copy.pasteInstead}</TextAction>}
            <TextAction onClick={() => actions.anotherDevice(row, flow)}>{copy.anotherDevice}</TextAction>
            <TextAction onClick={() => actions.cancel(flow)}>{copy.cancel}</TextAction>
          </div>
          {pasting && (
            <PasteForm flow={flow} hint={copy.deeplinkPasteHint} placeholder={copy.deeplinkPastePlaceholder} withLinkRow={false} onComplete={(url) => actions.complete(flow, url)} onCancel={() => actions.cancel(flow)} />
          )}
        </>
      );
    }
  } else if (row.state === "connected") {
    status = { text: host ? copy.connectedTo.replace("{host}", host) : copy.state.connected, tone: "ok" };
    trailing = <Check className="size-4 text-diff-add" strokeWidth={2.5} aria-label={copy.state.connected} />;
  } else if (flow?.phase === "failed") {
    status = { text: copy.failed, tone: "error" };
    body = (
      <>
        <FlowError error={flow.error} />
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => actions.connect(row)}>
            {copy.retry}
          </Button>
        </div>
      </>
    );
  } else if (row.state === "needs_auth") {
    status = { text: copy.state.needsAuth };
    trailing = (
      <Button type="button" size="sm" onClick={() => actions.connect(row)}>
        {copy.connect}
      </Button>
    );
  } else if (row.state === "missing") {
    status = { text: copy.state.missing.replace("{name}", name) };
    trailing = (
      <Button type="button" size="sm" variant="outline" onClick={() => actions.add(row)}>
        {copy.add}
      </Button>
    );
  } else {
    status = { text: row.state === "failed" ? copy.state.failed : copy.state.unknown, tone: row.state === "failed" ? "error" : undefined };
  }

  return (
    <div data-connect-row={row.runtimeId} className="flex gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      <span className="flex size-7 shrink-0 items-center justify-center">
        <AgentMark runtime={row.runtimeId} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm text-foreground">{agent}</span>
            <span
              data-testid={`connect-status-${row.runtimeId}`}
              className={cn("truncate font-mono text-[11px]", status.tone === "ok" ? "text-diff-add" : status.tone === "error" ? "text-destructive" : "text-text-faint")}
            >
              {status.text}
            </span>
          </div>
          {trailing}
        </div>
        {body}
      </div>
    </div>
  );
}

function TextAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="cursor-pointer text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground">
      {children}
    </button>
  );
}

function Spinner() {
  return <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-border border-t-primary" />;
}

function CopyLink({ url }: { url: string }) {
  const copy = useDict().integrations.connect;
  const [copied, setCopied] = useState(false);
  return (
    <TextAction
      onClick={() => {
        void navigator.clipboard
          ?.writeText(url)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? copy.copied : copy.copyLink}
    </TextAction>
  );
}

/** The address the browser ended on, checked before it goes to the relay:
 * the localhost mode's last step, and the way out when the app's own link
 * did not come back (`withLinkRow` off: that row already has the link). */
function PasteForm({ flow, hint, placeholder, withLinkRow, onComplete, onCancel }: { flow: McpAuthFlow; hint: string; placeholder: string; withLinkRow: boolean; onComplete: (url: string) => void; onCancel: () => void }) {
  const copy = useDict().integrations.connect;
  const [value, setValue] = useState("");
  const [error, setError] = useState<CallbackPasteError | null>(null);
  const submit = () => {
    const checked = checkCallbackPaste(value, flow);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    onComplete(checked.url);
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{hint}</p>
      {withLinkRow && flow.authUrl && (
        <div className="flex items-center gap-4">
          <CopyLink url={flow.authUrl} />
          <TextAction onClick={onCancel}>{copy.cancel}</TextAction>
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder={placeholder}
          aria-label={copy.pasteLabel}
          aria-invalid={error !== null}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={value.trim() === ""}>
          {copy.finish}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {copy.pasteErrors[error]}
        </p>
      )}
    </div>
  );
}
