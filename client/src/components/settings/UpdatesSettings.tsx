import { useState } from "react";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { Button } from "@/components/ui/button";
import { useAppUpdateSettings, useInstallOrigin } from "@/hooks/useAppUpdate";
import { useDict, useLocale } from "@/i18n";
import { forceUpdateCheck } from "@/lib/appUpdate";
import { APP_VERSION } from "@/lib/appVersion";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { UpdateMode } from "@/lib/settings";
import { cn } from "@/lib/utils";

const MODES: UpdateMode[] = ["notify", "auto-download", "off"];

/**
 * Plain `<button>`s in a `role="radiogroup"`, never a `DropdownMenu` — a
 * WebDriver click in the e2e tier's real WebKitGTK delivers `click` but no
 * `pointerdown`, so Radix's dropdown trigger (which opens on `pointerdown`)
 * never opens there. Three buttons need no such gesture.
 */
function ModeControl() {
  const dict = useDict().settings.updates.mode;
  const { settings, setUpdateMode } = useAppUpdateSettings();
  const origin = useInstallOrigin();
  const updatable = origin?.updatable ?? false;
  const current = settings.updateMode ?? "notify";

  const labels: Record<UpdateMode, string> = { notify: dict.notify, "auto-download": dict.autoDownload, off: dict.off };

  return (
    <div role="radiogroup" aria-label={dict.title} className="inline-flex border border-border">
      {MODES.map((mode) => {
        // Disabled rather than hidden: an install that can't apply an
        // update on its own still gets to see the option exists, with the
        // row's `notUpdatable` line saying why it's unavailable.
        const disabled = mode === "auto-download" && !updatable;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={current === mode}
            disabled={disabled}
            onClick={() => setUpdateMode(mode)}
            className={cn(
              "cursor-pointer border-r border-border px-3 py-1.5 font-mono text-xs transition-colors last:border-r-0",
              current === mode
                ? "bg-surface-hover text-foreground"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              disabled && "cursor-not-allowed text-text-faint opacity-50 hover:bg-transparent hover:text-text-faint",
            )}
          >
            {labels[mode]}
          </button>
        );
      })}
    </div>
  );
}

function CheckNowRow() {
  const dict = useDict().settings.updates;
  const { locale } = useLocale();
  const { settings } = useAppUpdateSettings();
  const [checking, setChecking] = useState(false);

  async function handleCheckNow(): Promise<void> {
    setChecking(true);
    try {
      await forceUpdateCheck();
    } finally {
      setChecking(false);
    }
  }

  const lastChecked =
    settings.lastCheckedAt === undefined ? dict.lastChecked.never : formatRelativeTime(settings.lastCheckedAt, locale);

  return (
    <SettingsRow title={dict.currentVersion} description={`${dict.lastChecked.label}: ${lastChecked}`}>
      <div className="flex items-center gap-2.5">
        <span className="border border-border bg-bg-chrome px-2 py-0.5 font-mono text-xs text-foreground tabular-nums">
          {APP_VERSION}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleCheckNow()} disabled={checking}>
          {checking ? dict.checkNow.checking : dict.checkNow.label}
        </Button>
      </div>
    </SettingsRow>
  );
}

/** Device-local and app-wide, same reasoning as `AppearanceSettings` — none
 * of this is scoped to a profile, so it sits under "app" rather than being
 * repeated on every profile page. */
export function UpdatesSettings() {
  const dict = useDict().settings.updates;
  const origin = useInstallOrigin();
  const updatable = origin?.updatable ?? false;

  return (
    <div className="flex flex-col">
      <header className="flex items-center gap-2.5 pt-5 pb-1.5">
        <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-foreground">{dict.title}</h2>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-text-faint">{dict.scope}</span>
      </header>

      <SettingsRow
        title={dict.mode.title}
        description={dict.mode.description}
        detail={
          // Only rendered once the probe answers, and only when it says no —
          // showing nothing during the brief round trip beats a false
          // "can't be updated" flash while origin is still null.
          origin && !updatable ? <p className="text-xs text-muted-foreground">{dict.notUpdatable}</p> : undefined
        }
      >
        <ModeControl />
      </SettingsRow>

      <CheckNowRow />
    </div>
  );
}
