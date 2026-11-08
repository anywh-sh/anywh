import { RailAddButton, type RailAddItem } from "@/components/shell/RailAddButton";
import { RailSelectedMark, railButtonClass } from "@/components/shell/railButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnectCard } from "@/components/integrations/ConnectCardProvider";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useDict } from "@/i18n";
import { addableProviders, railBadge, railIntegrations, runtimesNeedingAuth } from "@/lib/integrations/derive";
import type { IntegrationState } from "@/lib/integrations/model";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

interface IntegrationRailProps {
  profile: Profile;
  /** The integration the tab's pane shows, `null` when none is on screen. */
  selectedId: string | null;
  onToggle: (integrationId: string) => void;
}

/**
 * What sits under the rail's divider: one button per integration the tab's
 * profile has — a server in at least one of its agents, connected or not —
 * and the "+" that adds one it lacks, through the connect card: one line per
 * agent, each added and signed in on its own. The data is the profile's, not the
 * conversation's, so it is drawn by the dock itself rather than portaled in.
 * A relay without integrations draws the "+" alone, with nothing to offer.
 */
export function IntegrationRail({ profile, selectedId, onToggle }: IntegrationRailProps) {
  const dict = useDict();
  const integrations = useProfileIntegrations(profile.id);
  const openConnectCard = useConnectCard();
  if (!integrations || !openConnectCard) return <RailAddButton />;

  const items: RailAddItem[] = addableProviders(integrations.entry).map((provider) => {
    const name = dict.integrations.providers[provider];
    return {
      id: provider,
      label: dict.integrations.add.menuItem.replace("{name}", name),
      icon: <IntegrationIcon provider={provider} />,
      onSelect: () => openConnectCard(profile.id, provider),
    };
  });

  return (
    <>
      {railIntegrations(integrations.entry).map((integration) => (
        <IntegrationRailButton
          key={integration.id}
          integration={integration}
          selected={selectedId === integration.id}
          onToggle={() => onToggle(integration.id)}
        />
      ))}
      <RailAddButton items={items} />
    </>
  );
}

function IntegrationRailButton({ integration, selected, onToggle }: { integration: IntegrationState; selected: boolean; onToggle: () => void }) {
  const dict = useDict();
  const copy = dict.integrations.rail;
  const name = dict.integrations.providers[integration.provider];
  const badge = railBadge(integration);
  const needing = runtimesNeedingAuth(integration);
  const label =
    badge === "needs_auth"
      ? (needing === 1 ? copy.needsAuthOne : copy.needsAuthMany).replace("{name}", name).replace("{count}", String(needing))
      : badge === "failed"
        ? copy.failed.replace("{name}", name)
        : copy.open.replace("{name}", name);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onToggle} aria-label={label} aria-pressed={selected} data-integration={integration.id} className={railButtonClass(selected)}>
          <RailSelectedMark selected={selected} />
          <span className="relative">
            <IntegrationIcon provider={integration.provider} />
            {badge && (
              <span
                data-rail-badge={badge}
                aria-hidden="true"
                className={cn(
                  "absolute -top-0.5 -right-1 size-1.5 rounded-full ring-2 ring-bg-chrome",
                  badge === "needs_auth" ? "bg-warn" : "bg-destructive",
                )}
              />
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
