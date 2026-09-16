import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppUpdate, useInstallOrigin } from "@/hooks/useAppUpdate";
import { useDict } from "@/i18n";
import { dismissUpdate } from "@/lib/appUpdate";

/** Same one-liner `install.sh` itself prints and `ManualInstructions`
 * already spells out — copied verbatim rather than derived from the
 * marker's `path`, since the command re-detects the machine on its own. */
const INSTALL_COMMAND = "curl -fsSL https://anywh.sh/install | sh";

/**
 * Fase A of the in-app updater: a link or a command, never a button that
 * applies anything — there is no updater plugin yet to apply it with (Fase
 * B). Singular and app-wide, unlike `RevokedProfileBanner`'s one-per-profile
 * stack: there is only one running app to be behind on.
 *
 * No timer lives in here — `App.tsx` schedules the check this reads the
 * result of, on purpose, so this stays a trivial render of whatever store
 * state already exists.
 */
export function UpdateBanner() {
  const update = useAppUpdate();
  const origin = useInstallOrigin();
  const dict = useDict().shell.update;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  if (!update) return null;

  // Only install.sh leaves behind a marker that says so — every other route
  // (a .deb/.rpm, Homebrew's macOS cask-that-doesn't-exist-yet, a dev build)
  // has nothing this app could re-run for the user, so the honest action is
  // the release page.
  const viaInstallScript = origin?.marker?.method === "install.sh";

  async function handleAction(): Promise<void> {
    if (!viaInstallScript) {
      void openUrl(update?.htmlUrl ?? "");
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
    <div className="flex shrink-0 items-start gap-3 border-b border-border bg-bg-sidebar px-4 py-3">
      <Download className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-[10.5px] tracking-[0.11em] text-primary uppercase">{dict.eyebrow}</span>
        <span className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
          {dict.body.replace("{version}", update.version)}
          {viaInstallScript && <span className="ml-1.5 text-text-faint">{dict.restartHint}</span>}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => void handleAction()}>
          {!viaInstallScript
            ? dict.viewRelease
            : copyState === "copied"
              ? dict.copied
              : copyState === "failed"
                ? dict.copyFailed
                : dict.copyCommand}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={dict.dismiss}
          onClick={() => dismissUpdate(update.version)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
