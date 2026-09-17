import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppUpdate, useAppUpdateSettings, useDownloadedUpdate, useInstallOrigin } from "@/hooks/platform/useAppUpdate";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/install/appVersion";
import { installAndRestart } from "@/lib/install/updaterPlugin";
import { cn } from "@/lib/utils";

/** Same one-liner `install.sh` itself prints and `ManualInstructions`
 * already spells out — copied verbatim rather than derived from the
 * marker's `path`, since the command re-detects the machine on its own. */
const INSTALL_COMMAND = "curl -fsSL https://anywh.sh/install | sh";

/**
 * Phase A shipped a link or a command, never a button that applies anything
 * — there was no updater plugin yet to apply it with. Phase B added one, but
 * only auto-download mode ever calls it, and only from the scheduled check
 * (`appUpdate.ts`'s `runCheck`); this modal never triggers a download
 * itself, it only ever shows the result of one already sitting in
 * `useDownloadedUpdate()` and offers the explicit restart click that's the
 * one thing this app never does on its own. Opened from the footer's update
 * indicator (`StatusBar`, only rendered once something is available) or
 * manually from the title bar menu's "Check for updates", which opens this
 * regardless of outcome — so it doubles as the "you're up to date"
 * confirmation a manual check needs.
 *
 * Also the only home left for the update-mode toggle: Settings no longer has
 * an "Updates" page, and this is the one surface a user reaches specifically
 * because they're thinking about updates. `auto-download` is only offered
 * when `InstallOrigin.updatable` is true — `normalizeUpdateMode` would just
 * coerce it back to `notify` otherwise, so showing it would be a setting
 * that silently does nothing.
 */
export function UpdateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const update = useAppUpdate();
  const downloaded = useDownloadedUpdate();
  const origin = useInstallOrigin();
  const { settings, setUpdateMode } = useAppUpdateSettings();
  const dict = useDict().shell.updateModal;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [restarting, setRestarting] = useState(false);

  // Only install.sh leaves behind a marker that says so — every other route
  // (a .deb/.rpm, Homebrew's macOS cask-that-doesn't-exist-yet, a dev build)
  // has nothing this app could re-run for the user, so the honest action is
  // the release page.
  const viaInstallScript = origin?.marker?.method === "install.sh";
  const canAutoDownload = origin?.updatable ?? false;
  const mode = settings.updateMode ?? "notify";

  const modeOptions = [
    { mode: "notify" as const, label: dict.checkAutomaticallyOn },
    ...(canAutoDownload ? [{ mode: "auto-download" as const, label: dict.checkAutomaticallyAutoDownload }] : []),
    { mode: "off" as const, label: dict.checkAutomaticallyOff },
  ];

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

  async function handleRestart(): Promise<void> {
    if (!downloaded || restarting) return;
    setRestarting(true);
    await installAndRestart(downloaded);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{downloaded ? dict.readyTitle : update ? dict.title : dict.upToDateTitle}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {downloaded ? (
            <>
              <p className="text-sm text-pretty text-muted-foreground">
                {dict.readyBody.replace("{version}", downloaded.version)}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={restarting}
                onClick={() => void handleRestart()}
              >
                {dict.restartNow}
              </Button>
            </>
          ) : update ? (
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
            {modeOptions.map(({ mode: optionMode, label }) => (
              <button
                key={optionMode}
                type="button"
                role="radio"
                aria-checked={mode === optionMode}
                onClick={() => setUpdateMode(optionMode)}
                className={cn(
                  "cursor-pointer border-r border-border px-3 py-1.5 font-mono text-xs transition-colors last:border-r-0",
                  mode === optionMode
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
