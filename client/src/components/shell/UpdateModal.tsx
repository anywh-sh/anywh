import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppUpdate, useAppUpdateSettings, useInstallOrigin } from "@/hooks/useAppUpdate";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/appVersion";
import { cn } from "@/lib/utils";

/** Same one-liner `install.sh` itself prints and `ManualInstructions`
 * already spells out — copied verbatim rather than derived from the
 * marker's `path`, since the command re-detects the machine on its own. */
const INSTALL_COMMAND = "curl -fsSL https://anywh.sh/install | sh";

/**
 * Fase A of the in-app updater: a link or a command, never a button that
 * applies anything — there is no updater plugin yet to apply it with (Fase
 * B). Opened from the footer's update indicator (`StatusBar`, only rendered
 * once one is available) or manually from the title bar menu's "Check for
 * updates", which opens this regardless of outcome — so it doubles as the
 * "you're up to date" confirmation a manual check needs.
 *
 * Also the only home left for the update-mode toggle: Settings no longer has
 * an "Updates" page, and this is the one surface a user reaches specifically
 * because they're thinking about updates. `auto-download` isn't offered here
 * — nothing downloads anything yet (Fase B), so surfacing that option would
 * just be a setting that lies about what it does.
 */
export function UpdateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const update = useAppUpdate();
  const origin = useInstallOrigin();
  const { settings, setUpdateMode } = useAppUpdateSettings();
  const dict = useDict().shell.updateModal;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // Only install.sh leaves behind a marker that says so — every other route
  // (a .deb/.rpm, Homebrew's macOS cask-that-doesn't-exist-yet, a dev build)
  // has nothing this app could re-run for the user, so the honest action is
  // the release page.
  const viaInstallScript = origin?.marker?.method === "install.sh";
  const checksAutomatically = (settings.updateMode ?? "notify") !== "off";

  async function handleAction(): Promise<void> {
    if (!update) return;
    if (!viaInstallScript) {
      void openUrl(update.htmlUrl);
      return;
    }
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{update ? dict.title : dict.upToDateTitle}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {update ? (
            <>
              <p className="text-sm text-pretty text-muted-foreground">
                {dict.body.replace("{version}", update.version).replace("{current}", APP_VERSION)}
              </p>
              <Button variant="outline" size="sm" className="self-start" onClick={() => void handleAction()}>
                {!viaInstallScript
                  ? dict.viewRelease
                  : copyState === "copied"
                    ? dict.copied
                    : copyState === "failed"
                      ? dict.copyFailed
                      : dict.copyCommand}
              </Button>
              {viaInstallScript && <p className="text-xs text-text-faint">{dict.restartHint}</p>}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{dict.upToDateBody.replace("{version}", APP_VERSION)}</p>
          )}

          <div
            role="radiogroup"
            aria-label={dict.checkAutomatically}
            className="mt-1 inline-flex self-start border border-border"
          >
            {(
              [
                { mode: "notify" as const, on: true, label: dict.checkAutomaticallyOn },
                { mode: "off" as const, on: false, label: dict.checkAutomaticallyOff },
              ]
            ).map(({ mode, on, label }) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={checksAutomatically === on}
                onClick={() => setUpdateMode(mode)}
                className={cn(
                  "cursor-pointer border-r border-border px-3 py-1.5 font-mono text-xs transition-colors last:border-r-0",
                  checksAutomatically === on
                    ? "bg-surface-hover text-foreground"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
