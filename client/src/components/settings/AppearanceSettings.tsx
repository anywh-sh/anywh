import { LanguageControl } from "@/components/settings/LanguageControl";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { ThemeSection } from "@/components/settings/ThemeSection";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useFontSize,
} from "@/hooks/useFontSize";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles";

/**
 * Device-local, not scoped to any profile — unlike the profile pages, none
 * of this ever touches a relay, which is exactly why it sits under "app"
 * instead of being repeated on every profile.
 */
function FontSizeControl() {
  const dict = useDict();
  const { size, setSize } = useFontSize();

  return (
    <div className="flex w-52 flex-col items-end gap-2">
      <div className="flex w-full items-center gap-2.5">
        <span className="font-mono text-[10px] text-text-faint">{MIN_FONT_SIZE}</span>
        <input
          type="range"
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          step={FONT_SIZE_STEP}
          value={size}
          onChange={(event) => setSize(Number(event.target.value))}
          className="min-w-0 flex-1 accent-primary"
        />
        <span className="font-mono text-[10px] text-text-faint">{MAX_FONT_SIZE}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="border border-border bg-bg-chrome px-2 py-0.5 font-mono text-xs text-foreground tabular-nums">
          {size}
        </span>
        {size !== DEFAULT_FONT_SIZE && (
          <button
            type="button"
            onClick={() => setSize(DEFAULT_FONT_SIZE)}
            className="cursor-pointer font-mono text-[10.5px] text-text-faint transition-colors hover:text-foreground"
          >
            {dict.settings.appearance.fontSize.reset}
          </button>
        )}
      </div>
    </div>
  );
}

/** The one page that isn't about a profile: how the app looks and reads on
 * this device, whichever profile happens to be in front. */
export function AppearanceSettings({ activeProfile }: { activeProfile: Profile }) {
  const dict = useDict();
  const { size } = useFontSize();

  return (
    <div className="flex flex-col">
      <header className="flex items-center gap-2.5 pt-5 pb-1.5">
        <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-foreground">
          {dict.settings.appearance.title}
        </h2>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-text-faint">{dict.settings.appearance.scope}</span>
      </header>

      <ThemeSection activeProfile={activeProfile} />

      <SettingsRow
        title={dict.settings.appearance.fontSize.title}
        description={dict.settings.appearance.fontSize.description}
        detail={
          // Rendered at the chosen size: the number on its own says
          // nothing, and the app behind the dialog is mostly covered while
          // this is open.
          <p
            className="border border-border bg-bg-chrome px-3 py-2.5 text-muted-foreground"
            style={{ fontSize: `${String(size)}px` }}
          >
            {dict.settings.appearance.fontSize.sample}
          </p>
        }
      >
        <FontSizeControl />
      </SettingsRow>

      <SettingsRow title={dict.settings.language.title} description={dict.settings.language.description}>
        <LanguageControl />
      </SettingsRow>
    </div>
  );
}
