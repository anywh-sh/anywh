import { Button } from "@/components/ui/button";
import { useRelayUpdate } from "@/hooks/relay/useRelayUpdate";
import { useDict } from "@/i18n";
import { APP_VERSION, isUnreleasedVersion } from "@/lib/install/appVersion";
import type { Profile } from "@/lib/profiles/profiles";

/** The command that updates a relay where the app cannot (another machine). */
export const RELAY_UPDATE_COMMAND = "curl -fsSL https://anywh.sh/install | sh -s -- --relay-only";

/**
 * Where bots would be when the profile's relay predates them: which version
 * brings them, which one it runs, and the way to update it from here — the
 * button when the app can do it, otherwise the command for the machine that
 * can. The new relay runs from its next restart (the update never restarts a
 * relay with work in flight).
 */
export function BotsRelayGate({ profile, relayVersion }: { profile: Profile; relayVersion?: string }) {
  const dict = useDict().bots.relayGate;
  const update = useRelayUpdate(profile);
  // This app's version is the first one known to bring bots; a build from
  // source has no release number to name.
  const known = !isUnreleasedVersion(APP_VERSION) && relayVersion !== undefined && !isUnreleasedVersion(relayVersion);
  return (
    <div className="flex flex-col gap-3 px-4 py-6" data-testid="bots-relay-gate">
      <span className="text-sm font-medium text-foreground">{dict.title}</span>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {known ? dict.body.replace("{required}", `v${APP_VERSION}`).replace("{current}", `v${relayVersion}`) : dict.bodyUnknown}
      </p>
      {update.kind === "in-app" ? (
        update.status === "done" ? (
          <p className="text-xs text-muted-foreground">{dict.updated}</p>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            <Button variant="outline" size="xs" onClick={() => void update.run()} loading={update.status === "running"}>
              {update.status === "running" ? dict.updating : dict.update}
            </Button>
            {update.error && <span className="text-xs text-destructive">{update.error}</span>}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-faint">{update.kind === "brew" ? dict.brewHint : dict.manualHint}</span>
          <code className="border border-border bg-bg-chrome px-2 py-1 font-mono text-[11px] break-all text-foreground select-all">
            {update.kind === "brew" ? "brew upgrade anywh-relay" : RELAY_UPDATE_COMMAND}
          </code>
        </div>
      )}
    </div>
  );
}
