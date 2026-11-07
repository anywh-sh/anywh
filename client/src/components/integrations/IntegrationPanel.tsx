import { SessionPanel } from "@/components/shell/SessionPanel";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useDict } from "@/i18n";
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
 * integration's name and, once known, the site it reads from.
 */
export function IntegrationPanel({ profile, integrationId, maximized, onToggleMaximized, onClose }: IntegrationPanelProps) {
  const dict = useDict();
  const integrations = useProfileIntegrations(profile.id);
  const integration = integrations?.entry.integrations?.find((entry) => entry.id === integrationId);
  const provider = integration?.provider ?? (integrationId === "linear" ? "linear" : "jira");
  const host = integration?.site ? hostOf(integration.site.url) : null;

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
      <div className="h-full bg-bg-chrome" />
    </SessionPanel>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
