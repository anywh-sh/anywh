import { RelayUpgradeAction } from "@/components/shell/RelayUpgradeBanner";
import { useLegacyRelayUpgrade, type LegacyUpgradeState } from "@/hooks/relay/useLegacyRelayUpgrade";
import { useDict } from "@/i18n";
import { isUnreleasedVersion } from "@/lib/install/appVersion";
import type { Profile } from "@/lib/profiles/profiles";

/** The command that updates a relay where the app cannot (another machine). */
export const RELAY_UPDATE_COMMAND = "curl -fsSL https://anywh.sh/install | sh -s -- --relay-only";

/**
 * Where bots would be when the profile's relay predates them: which version
 * brings them, which one it runs, and the way to update it — the same
 * one-button update the notice offers (useLegacyRelayUpgrade), which waits
 * for conversations to finish before restarting the relay. When the app
 * cannot offer it (a relay that does not say its version), the command for
 * the machine that can.
 */
export function BotsRelayGate({ profile, relayVersion }: { profile: Profile; relayVersion?: string }) {
  const { state, start } = useLegacyRelayUpgrade(profile);
  return <BotsRelayGateView relayVersion={relayVersion} state={state} onUpdate={start} />;
}

/** What the gate shows for a given update state — no fetching (stories). */
export function BotsRelayGateView({ relayVersion, state, onUpdate }: { relayVersion?: string; state: LegacyUpgradeState; onUpdate: () => void }) {
  const dict = useDict().bots.relayGate;
  // Only the relay's own version is named: this app's version is not the
  // first that brings bots, only one that has them. A build from source has
  // no release number to name.
  const known = relayVersion !== undefined && !isUnreleasedVersion(relayVersion);
  return (
    <div className="flex flex-col gap-3 px-4 py-6" data-testid="bots-relay-gate">
      <span className="text-sm font-medium text-foreground">{dict.title}</span>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {known ? dict.body.replace("{current}", `v${relayVersion}`) : dict.bodyUnknown}
      </p>
      {state.phase !== "hidden" ? (
        <RelayUpgradeAction state={state} onUpdate={onUpdate} align="start" />
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-faint">{dict.manualHint}</span>
          <code className="border border-border bg-bg-chrome px-2 py-1 font-mono text-[11px] break-all text-foreground select-all">
            {RELAY_UPDATE_COMMAND}
          </code>
        </div>
      )}
    </div>
  );
}
