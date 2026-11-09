import { SettingsRow } from "@/components/settings/SettingsRow";
import { TELEMETRY_DOCS_URL } from "@/components/shell/FirstLaunchBanner";
import { Switch } from "@/components/ui/switch";
import { useTelemetryConsent } from "@/hooks/useTelemetryConsent";
import { useDict } from "@/i18n";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";

/**
 * What the app sends, and the way to stop it. The switch is the saved
 * choice; when something stronger than the choice decides — the environment
 * variable that opens the app with it off, or a build with no analytics at
 * all — it is locked off and says why, and the saved choice underneath is
 * left as it was.
 */
export function PrivacySettings() {
  const copy = useDict().settings.privacy;
  const { enabled, available, lockedByEnv, accept, decline } = useTelemetryConsent();
  const lockedReason = lockedByEnv ? copy.lockedByEnv : !available ? copy.lockedNoAnalytics : null;

  return (
    <div className="flex flex-col">
      <header className="flex items-center gap-2.5 pt-5 pb-1.5">
        <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-foreground">{copy.title}</h2>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-text-faint">{copy.scope}</span>
      </header>

      <SettingsRow
        title={copy.share.title}
        description={copy.share.description}
        detail={
          <div className="flex flex-col gap-2">
            {lockedReason && <p className="text-xs leading-relaxed text-pretty text-text-faint">{lockedReason}</p>}
            <a
              href={TELEMETRY_DOCS_URL}
              onClick={(event) => handleExternalLinkClick(event, TELEMETRY_DOCS_URL)}
              className="w-fit font-mono text-[11px] text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
            >
              {copy.share.learnMore}
            </a>
          </div>
        }
      >
        <Switch
          aria-label={copy.share.title}
          checked={enabled}
          disabled={lockedReason !== null}
          onCheckedChange={(next) => {
            if (next) accept();
            else decline("settings");
          }}
        />
      </SettingsRow>
    </div>
  );
}
