import { createContext, useCallback, useContext, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useConnectCard } from "@/components/integrations/ConnectCardProvider";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useDict } from "@/i18n";
import { integrationForServer } from "@/lib/integrations/connect";
import type { IntegrationProvider, McpStateMessage } from "@/lib/integrations/model";
import { cn } from "@/lib/utils";

/** What a chat offers for one of its agent's MCP servers that has to sign in:
 * which integration it is, and the way to its connect card. */
export interface McpConnectTarget {
  provider: IntegrationProvider;
  /** The chat's agent, as the person knows it ("Claude Code"). */
  agentName: string | null;
  open: () => void;
}

/** From a server's name to its connect card; `null` when the server belongs
 * to no integration the profile knows (or there is no card to open). */
export type McpConnectResolver = (server: string) => McpConnectTarget | null;

/** Provided by a chat panel to the rows of its log, which sit too deep (and
 * too memoized) to be handed a callback each. */
export const McpConnectContext = createContext<McpConnectResolver | null>(null);

export function useMcpConnectTarget(server: string | undefined): McpConnectTarget | null {
  const resolve = useContext(McpConnectContext);
  return server && resolve ? resolve(server) : null;
}

/**
 * The resolver of one chat: a server is an integration's when the profile's
 * integration names it for the chat's agent, or when the session's own
 * `mcp_state` says so.
 */
export function useMcpConnectResolver(profileId: string, agentId: string | null, agentName: string | null, mcpState: McpStateMessage | null): McpConnectResolver | null {
  const integrations = useProfileIntegrations(profileId);
  const openCard = useConnectCard();
  const list = integrations?.entry.integrations ?? null;
  const resolve = useCallback<McpConnectResolver>(
    (server) => {
      if (!openCard) return null;
      const integration =
        integrationForServer(list, agentId, server) ??
        list?.find((entry) => entry.id === mcpState?.servers.find((candidate) => candidate.name === server)?.integrationId);
      if (!integration) return null;
      return { provider: integration.provider, agentName, open: () => openCard(profileId, integration.id) };
    },
    [openCard, list, agentId, agentName, mcpState, profileId],
  );
  return useMemo(() => (openCard ? resolve : null), [openCard, resolve]);
}

/** "Claude Code is not connected to Jira — Connect", the one sentence every
 * chat-side entry into the connect card says. */
export function McpConnectNotice({ target, className }: { target: McpConnectTarget; className?: string }) {
  const dict = useDict();
  const copy = dict.integrations.chat;
  const name = dict.integrations.providers[target.provider];
  const text = target.agentName ? copy.agentNotConnected.replace("{agent}", target.agentName).replace("{name}", name) : copy.notConnected.replace("{name}", name);
  return (
    <div data-mcp-connect={target.provider} className={cn("flex items-center gap-2.5 border border-border bg-bg-elevated px-3 py-2", className)}>
      <IntegrationIcon provider={target.provider} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{text}</span>
      <Button type="button" size="xs" onClick={target.open}>
        {copy.connect}
      </Button>
    </div>
  );
}

/**
 * Above the composer: the session's agent has a server of a known
 * integration that has to sign in, and the relay can run that sign-in. One
 * line per integration, quiet until the person acts on it.
 */
export function McpNeedsAuthChip({ mcpState }: { mcpState: McpStateMessage | null }) {
  const resolve = useContext(McpConnectContext);
  if (!mcpState || !resolve) return null;
  const seen = new Set<string>();
  const targets: McpConnectTarget[] = [];
  for (const server of mcpState.servers) {
    if (server.status !== "needs_auth" || !server.canLogin || !server.integrationId || seen.has(server.integrationId)) continue;
    const target = resolve(server.name);
    if (!target) continue;
    seen.add(server.integrationId);
    targets.push(target);
  }
  if (targets.length === 0) return null;
  return (
    <div data-testid="mcp-needs-auth" className="mb-2 flex flex-col gap-1.5">
      {targets.map((target) => (
        <McpConnectNotice key={target.provider} target={target} />
      ))}
    </div>
  );
}
