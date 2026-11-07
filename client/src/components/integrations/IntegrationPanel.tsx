import { useEffect, useRef, useState } from "react";
import { SessionPanel } from "@/components/shell/SessionPanel";
import { RefreshIconButton, useRefreshControl } from "@/components/shell/RefreshControl";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useConnectCard } from "@/components/integrations/ConnectCardProvider";
import { ProjectDropdown } from "@/components/integrations/ProjectDropdown";
import { TicketList } from "@/components/integrations/TicketList";
import { TicketScreen } from "@/components/integrations/TicketScreen";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useDict, useLocale } from "@/i18n";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import { integrationDataState, pickFetchRuntime, runtimesNeedingAuth, siteHost } from "@/lib/integrations/derive";
import type { IntegrationProvider, IntegrationState, IntegrationsClientMessage, QueryState, TicketRef, WorkTicket } from "@/lib/integrations/model";
import { mineQuery, projectOptions, queryCooldown, queryView, ticketQuery, ticketView, visibleRows } from "@/lib/integrations/tickets";
import { canWorkHere, linksOnTicket, ticketRefFor, type WorkTicketMap } from "@/lib/integrations/workTickets";
import { TicketSessions, TicketWorkActions, useProfileRooms, type TicketRoomChoice } from "@/components/integrations/SessionLinkChips";
import type { Profile } from "@/lib/profiles/profiles";

interface IntegrationPanelProps {
  profile: Profile;
  integrationId: string;
  /** The ticket on screen; `null` shows the list. */
  ticketKey: string | null;
  onOpenTicket: (ticketKey: string | null) => void;
  /** The session of the tab beside the pane, when it can take a ticket (it
   * exists on the relay and is not a room). */
  sessionId: string | null;
  /** "New session" on a ticket's screen. */
  onNewSession: (ticket: TicketRef) => void;
  /** A session listed on a ticket's screen. */
  onOpenSession: (sessionId: string, title: string | null) => void;
  /** "Work on it in a room…": one of the profile's rooms, or a new one. */
  onWorkInRoom: (ticket: TicketRef, room: TicketRoomChoice | null) => void;
  /** A room's agent listed on a ticket's screen. */
  onOpenRoomAgent: (roomId: string, roomTitle: string | null, agentId: string) => void;
  maximized: boolean;
  onToggleMaximized: () => void;
  onClose: () => void;
}

/**
 * The dock pane of one integration: the shared pane shell, headed by the
 * integration's name and, once known, the site it reads from. Its body is
 * the tickets assigned to the person — in every project or the one the
 * profile remembers — or, with a `ticketKey`, that ticket's screen. Data is
 * the relay's cache: opening shows it as is and only reads what is not
 * there; ↻ reads again. While an agent has to sign in, the pane says so
 * first and opens the connect card.
 */
export function IntegrationPanel({ profile, integrationId, ticketKey, onOpenTicket, sessionId, onNewSession, onOpenSession, onWorkInRoom, onOpenRoomAgent, maximized, onToggleMaximized, onClose }: IntegrationPanelProps) {
  const dict = useDict();
  const integrations = useProfileIntegrations(profile.id);
  const integration = integrations?.entry.integrations?.find((entry) => entry.id === integrationId);
  const provider = integration?.provider ?? (integrationId === "linear" ? "linear" : "jira");
  const host = siteHost(integration);

  return (
    <SessionPanel
      maximized={maximized}
      onToggleMaximized={onToggleMaximized}
      onClose={onClose}
      headerExtra={
        <div data-testid="integration-panel-header" className="flex h-8 min-w-0 items-center gap-2 px-3 text-[13px]">
          <IntegrationIcon provider={provider} className="size-3.5 text-muted-foreground" />
          <span className="truncate text-foreground">{dict.integrations.providers[provider]}</span>
          {host && <span className="truncate font-mono text-[11px] text-text-faint">{host}</span>}
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col bg-bg-chrome">
        {integration && integrations && (
          <IntegrationBody
            profileId={profile.id}
            integration={integration}
            provider={provider}
            stale={integrationDataState(integrations.entry) !== "live"}
            receivedAt={integrations.entry.receivedAt}
            send={integrations.send}
            ticketKey={ticketKey}
            onOpenTicket={onOpenTicket}
            links={integrations.entry.workTickets}
            sessionId={sessionId}
            onNewSession={onNewSession}
            onOpenSession={onOpenSession}
            onWorkInRoom={onWorkInRoom}
            onOpenRoomAgent={onOpenRoomAgent}
          />
        )}
      </div>
    </SessionPanel>
  );
}

interface BodyProps {
  profileId: string;
  integration: IntegrationState;
  provider: IntegrationProvider;
  /** The relay is unreachable: everything shown is its last answer. */
  stale: boolean;
  receivedAt: number | null;
  send: (message: IntegrationsClientMessage) => boolean;
  ticketKey: string | null;
  onOpenTicket: (ticketKey: string | null) => void;
  /** Every session's work ticket, `null` until the relay has said. */
  links: WorkTicketMap | null;
  sessionId: string | null;
  onNewSession: (ticket: TicketRef) => void;
  onOpenSession: (sessionId: string, title: string | null) => void;
  onWorkInRoom: (ticket: TicketRef, room: TicketRoomChoice | null) => void;
  onOpenRoomAgent: (roomId: string, roomTitle: string | null, agentId: string) => void;
}

function IntegrationBody({ profileId, integration, provider, stale, receivedAt, send, ticketKey, onOpenTicket, links, sessionId, onNewSession, onOpenSession, onWorkInRoom, onOpenRoomAgent }: BodyProps) {
  const dict = useDict();
  const copy = dict.integrations.tickets;
  const canRead = !stale && pickFetchRuntime(integration) !== undefined;
  const rooms = useProfileRooms(profileId);
  // `send` changes with every state the relay pushes; the effects below
  // must fire on what they read, not on that.
  const sendRef = useRef(send);
  sendRef.current = send;

  // The remembered project lives on the relay; a pick shows at once and
  // gives way to the relay's answer.
  const remembered = integration.prefs.project;
  const [picked, setPicked] = useState<{ project: string | null } | null>(null);
  useEffect(() => {
    if (picked && picked.project === remembered) setPicked(null);
  }, [picked, remembered]);
  const project = picked ? picked.project : remembered;
  const listName = project ?? copy.allMine;

  const query: QueryState | undefined = ticketKey ? ticketQuery(integration, ticketKey) : mineQuery(integration, project);
  const queryKind = ticketKey ? "ticket" : "mine";
  const param = ticketKey ?? project;

  // Opening (the pane, a project, a ticket) serves the cache and reads only
  // what is missing — a ticket screen revalidates.
  useEffect(() => {
    if (canRead) sendRef.current({ type: "integration_refresh", id: integration.id, query: queryKind, param, force: false });
  }, [canRead, integration.id, queryKind, param]);

  const now = useNow(receivedAt, queryCooldown(query, Date.now()) !== null);
  const { locale } = useLocale();
  const control = useRefreshControl({
    reading: !stale && query?.reading === true,
    cooldownMs: queryCooldown(query, now),
    age: query?.observedAt !== undefined ? copy.updated.replace("{ago}", formatRelativeTime(query.observedAt, locale)) : null,
    onRefresh: () => sendRef.current({ type: "integration_refresh", id: integration.id, query: queryKind, param, force: true }),
    labels: { refresh: ticketKey ? copy.ticket.refresh : copy.refresh, againIn: copy.againIn },
  });
  const refreshButton = canRead ? (
    <RefreshIconButton reading={control.reading} held={control.held} title={control.title} onClick={control.handleRefresh} label={ticketKey ? copy.ticket.refresh : copy.refresh} />
  ) : null;
  const freshness = (control.age !== null || stale) && (
    <p data-testid="integration-freshness" className="font-mono text-[11px] text-text-faint">
      {[stale ? copy.offline : null, control.age].filter(Boolean).join(" · ")}
    </p>
  );

  if (ticketKey) {
    const { detail, row } = ticketView(integration, ticketKey);
    const view = queryView(query);
    const ticket = ticketRefFor(integration, ticketKey);
    const onTicket = linksOnTicket(links, { provider, key: ticketKey });
    // Both need the ticket's site, which the relay learns on its first read.
    const workHere = ticket !== null && !stale && canWorkHere(links, sessionId);
    return (
      <TicketScreen
        ticketKey={ticketKey}
        detail={detail}
        row={row}
        listName={listName}
        providerName={dict.integrations.providers[provider]}
        toolbar={refreshButton}
        placeholder={
          <div className="flex flex-col gap-2">
            {view === "error" ? <p className="text-sm text-destructive">{copy.ticket.error}</p> : view === "needs_auth" ? <QueryNeedsAuth profileId={profileId} integration={integration} provider={provider} /> : <p className="text-sm text-text-faint">{copy.ticket.loading}</p>}
          </div>
        }
        sessions={links !== null && <TicketSessions profileId={profileId} links={onTicket} onOpen={onOpenSession} onOpenRoomAgent={onOpenRoomAgent} />}
        footer={
          <TicketWorkActions
            workHere={workHere}
            onWorkHere={() => {
              if (ticket && sessionId) sendRef.current({ type: "work_ticket", sessionId, action: "link", ticket });
            }}
            onNewSession={ticket ? () => onNewSession(ticket) : null}
            rooms={rooms}
            onWorkInRoom={ticket ? (room) => onWorkInRoom(ticket, room) : null}
          />
        }
        onBack={() => onOpenTicket(null)}
      />
    );
  }

  const view = queryView(query);
  const mine = query?.query === "mine" ? query : undefined;
  const rows = visibleRows(mine);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-3">
        <div className="flex items-center gap-2">
          <ProjectDropdown
            provider={provider}
            value={project}
            projects={projectOptions(integration)}
            disabled={stale}
            onChange={(next) => {
              if (next === project) return;
              // Switched only once the relay has the choice to save.
              if (sendRef.current({ type: "integration_prefs", id: integration.id, prefs: { project: next } })) setPicked({ project: next });
            }}
          />
          {refreshButton}
        </div>
        {freshness}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <div className="px-1">
          <ConnectNotice profileId={profileId} integration={integration} provider={provider} />
        </div>
        {mine?.status === "error" && view === "ready" && (
          <QueryError provider={provider} disabled={!canRead || control.held} onRetry={control.handleRefresh} />
        )}
        {mine?.status === "needs_auth" && view === "ready" && <QueryNeedsAuth profileId={profileId} integration={integration} provider={provider} />}
        {view === "ready" ? (
          rows.length === 0 ? (
            <p className="px-1 py-6 text-sm text-text-faint">{project ? copy.emptyProject.replace("{project}", project) : copy.empty}</p>
          ) : (
            <LoadingMoreList
              key={`${project ?? "*"}`}
              rows={rows}
              profileId={profileId}
              linksByKey={linksByKey(links, provider)}
              stale={stale}
              hasMore={mine?.nextPageToken !== undefined}
              reading={mine?.reading === true}
              receivedAt={receivedAt}
              onOpen={(key) => onOpenTicket(key)}
              onLoadMore={() => sendRef.current({ type: "integration_load_more", id: integration.id, query: "mine", param: project })}
            />
          )
        ) : view === "error" ? (
          <QueryError provider={provider} disabled={!canRead || control.held} onRetry={control.handleRefresh} />
        ) : view === "needs_auth" ? (
          <QueryNeedsAuth profileId={profileId} integration={integration} provider={provider} />
        ) : canRead ? (
          <p data-testid="tickets-loading" className="px-1 py-6 text-sm text-text-faint">
            {copy.loading}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The list with "Load more" pending from the click until the relay answers
 * with a state that is not reading any more. */
function LoadingMoreList({
  rows,
  profileId,
  linksByKey,
  stale,
  hasMore,
  reading,
  receivedAt,
  onOpen,
  onLoadMore,
}: {
  rows: Parameters<typeof TicketList>[0]["rows"];
  profileId: string;
  linksByKey: ReadonlyMap<string, WorkTicket[]>;
  stale: boolean;
  hasMore: boolean;
  reading: boolean;
  receivedAt: number | null;
  onOpen: (key: string) => void;
  /** False when the ask never left (the socket is not open). */
  onLoadMore: () => boolean;
}) {
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  useEffect(() => {
    if (pendingSince !== null && !reading && receivedAt !== null && receivedAt > pendingSince) setPendingSince(null);
  }, [pendingSince, reading, receivedAt]);
  return (
    <TicketList
      rows={rows}
      profileId={profileId}
      linksByKey={linksByKey}
      stale={stale}
      hasMore={hasMore}
      loadingMore={pendingSince !== null}
      onOpen={onOpen}
      onLoadMore={() => {
        const since = Date.now();
        if (onLoadMore()) setPendingSince(since);
      }}
    />
  );
}

/** The sessions working on each of the provider's tickets, by key. */
function linksByKey(links: WorkTicketMap | null, provider: IntegrationProvider): Map<string, WorkTicket[]> {
  const byKey = new Map<string, WorkTicket[]>();
  for (const link of Object.values(links ?? {})) {
    if (link.ticket.provider !== provider) continue;
    byKey.set(link.ticket.key, [...(byKey.get(link.ticket.key) ?? []), link]);
  }
  for (const list of byKey.values()) list.sort((a, b) => b.linkedAt - a.linkedAt);
  return byKey;
}

/** The clock of the pane: once a second while a refresh is held (the
 * countdown), every half minute otherwise ("updated 4 minutes ago"), and on
 * every state the relay pushes. */
function useNow(receivedAt: number | null, fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [receivedAt]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [fast]);
  return now;
}

function QueryError({ provider, disabled, onRetry }: { provider: IntegrationProvider; disabled: boolean; onRetry: () => void }) {
  const dict = useDict();
  const copy = dict.integrations.tickets;
  return (
    <div role="alert" className="mx-1 mb-2 flex items-center gap-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-foreground">
      <span className="min-w-0 flex-1 truncate">{copy.error.replace("{name}", dict.integrations.providers[provider])}</span>
      <button type="button" disabled={disabled} onClick={onRetry} className="shrink-0 cursor-pointer text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:cursor-default disabled:opacity-50">
        {copy.retry}
      </button>
    </div>
  );
}

/** A read the tracker refused for want of a sign-in, while the agents still
 * look connected (an expired token is only found by using it). */
function QueryNeedsAuth({ profileId, integration, provider }: { profileId: string; integration: IntegrationState; provider: IntegrationProvider }) {
  const dict = useDict();
  const copy = dict.integrations.tickets;
  const openConnectCard = useConnectCard();
  // The pane's notice already says it when an agent is marked.
  if (runtimesNeedingAuth(integration) > 0) return null;
  return (
    <div className="mx-1 mb-2 flex items-center gap-2 border border-border bg-bg-elevated px-3 py-2 text-[13px] text-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
      <span className="min-w-0 flex-1 truncate">{copy.needsAuth.replace("{name}", dict.integrations.providers[provider])}</span>
      {openConnectCard && (
        <Button type="button" size="xs" variant="outline" onClick={() => openConnectCard(profileId, integration.id)}>
          {copy.connect}
        </Button>
      )}
    </div>
  );
}

/** "No agent of this profile is connected to Jira — Connect": the pane's way
 * into the connect card. Prominent while no agent can read, a line when only
 * some have to sign in. */
export function ConnectNotice({ profileId, integration, provider }: { profileId: string; integration: IntegrationState; provider: IntegrationProvider }) {
  const dict = useDict();
  const copy = dict.integrations.panel;
  const openConnectCard = useConnectCard();
  const needing = runtimesNeedingAuth(integration);
  if (needing === 0 || !openConnectCard) return null;
  const name = dict.integrations.providers[provider];
  const blocked = pickFetchRuntime(integration) === undefined;
  const text = blocked
    ? copy.noneConnected.replace("{name}", name)
    : (needing === 1 ? copy.needsAuthOne : copy.needsAuthMany).replace("{name}", name).replace("{count}", String(needing));
  const open = () => openConnectCard(profileId, integration.id);
  if (!blocked) {
    return (
      <div data-testid="integration-connect-notice" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <Button type="button" size="xs" variant="outline" onClick={open}>
          {copy.connect}
        </Button>
      </div>
    );
  }
  return (
    <div data-testid="integration-connect-notice" className="mb-2 flex flex-col items-start gap-3 border border-border bg-bg-elevated p-4">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
        {text}
      </p>
      <Button type="button" size="sm" onClick={open}>
        {copy.connect}
      </Button>
    </div>
  );
}
