import { SessionPanel } from "@/components/shell/SessionPanel";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useConnectCard } from "@/components/integrations/ConnectCardProvider";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useDict } from "@/i18n";
import { pickFetchRuntime, runtimesNeedingAuth, siteHost } from "@/lib/integrations/derive";
import type { IntegrationProvider, IntegrationState } from "@/lib/integrations/model";
import type { Profile } from "@/lib/profiles/profiles";

interface IntegrationPanelProps {
  profile: Profile;
  integrationId: string;
  maximized: boolean;
  onToggleMaximized: () => void;
  onClose: () => void;
}

/**
 * The dock pane of one integration: the shared pane shell, headed by the
 * integration's name and, once known, the site it reads from. While an
 * agent has to sign in, the pane says so first and opens the connect card.
 */
export function IntegrationPanel({ profile, integrationId, maximized, onToggleMaximized, onClose }: IntegrationPanelProps) {
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
      <div className="flex h-full flex-col overflow-y-auto bg-bg-chrome p-3">
        {integration && <ConnectNotice profileId={profile.id} integration={integration} provider={provider} />}
      </div>
    </SessionPanel>
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
    <div data-testid="integration-connect-notice" className="flex flex-col items-start gap-3 border border-border bg-bg-elevated p-4">
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
