import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  useAppUpdate,
  useAppUpdateSettings,
  useInstallOrigin,
  useReadyUpdate,
  useRestartIntoUpdate,
  useUpdateActivity,
} from "@/hooks/platform/useAppUpdate";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/install/appVersion";
import { resolveUpdateMode } from "@/lib/install/updateMode";
import { cn } from "@/lib/utils";

/** Same one-liner `install.sh` itself prints and `ManualInstructions`
 * already spells out — copied verbatim rather than derived from the
 * marker's `path`, since the command re-detects the machine on its own. */
const INSTALL_COMMAND = "curl -fsSL https://anywh.sh/install | sh";

/**
 * Secondary surface of the in-app updater. The primary one is the title bar's
 * restart button (`UpdateRestartButton`), which needs no modal click: the
 * scheduled check downloads and installs on its own. This opens from the
 * footer's update indicator or the title bar menu's "Check for updates"
 * (regardless of outcome, so it doubles as the "you're up to date"
 * confirmation a manual check needs), and shows what a restart is waiting on.
 * It never starts a download itself.
 *
 * Also the only home of the update-mode toggle: Settings has no "Updates"
 * page, and this is the surface a user reaches because they're thinking about
 * updates. "Install automatically" is only offered when
 * `InstallOrigin.updatable` is true — `resolveUpdateMode` would coerce it to
 * notify-only otherwise, so showing it would be a setting that silently does
 * nothing.
 */
export function UpdateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const update = useAppUpdate();
  const ready = useReadyUpdate();
  const activity = useUpdateActivity();
  const origin = useInstallOrigin();
  const { settings, setUpdateMode } = useAppUpdateSettings();
  const dict = useDict().shell.updateModal;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const { restart, restarting } = useRestartIntoUpdate();

  // Only install.sh leaves behind a marker that says so — every other route
  // (a .deb/.rpm, Homebrew's macOS cask-that-doesn't-exist-yet, a dev build)
  // has nothing this app could re-run for the user, so the honest action is
  // the release page.
  const viaInstallScript = origin?.marker?.method === "install.sh";
  const canAutoInstall = origin?.updatable ?? false;
  // What actually runs, not what's stored: an unset value is automatic on an
  // updatable origin, so the control has to show that rather than "Notify".
  const mode = resolveUpdateMode(settings.updateMode, canAutoInstall);

  const modeOptions = [
    { mode: "notify" as const, label: dict.checkAutomaticallyNotify },
    ...(canAutoInstall ? [{ mode: "auto-download" as const, label: dict.checkAutomaticallyInstall }] : []),
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {ready
              ? dict.readyTitle
              : update
                ? dict.title
                : activity.checking
                  ? dict.checkingTitle
                  : dict.upToDateTitle}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {ready ? (
            <>
              <p className="text-sm text-pretty text-muted-foreground">
                {(ready.installed ? dict.readyBodyInstalled : dict.readyBodyDownloaded).replace(
                  "{version}",
                  ready.update.version,
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={restarting}
                onClick={() => void restart()}
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
              {activity.download === "downloading" ? (
                <p className="text-xs text-text-faint">{dict.downloadingHint}</p>
              ) : activity.download === "failed" ? (
                <p className="text-xs text-text-faint">{dict.downloadFailedHint}</p>
              ) : (
                mode !== "auto-download" &&
                viaInstallScript && <p className="text-xs text-text-faint">{dict.restartHint}</p>
              )}
            </>
          ) : activity.checking ? (
            <p className="text-sm text-muted-foreground">{dict.checkingBody}</p>
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
