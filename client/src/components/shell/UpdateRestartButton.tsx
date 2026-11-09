import { ArrowUpCircle, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReadyUpdate, useRestartIntoUpdate } from "@/hooks/platform/useAppUpdate";
import { useDict } from "@/i18n";
import { dismissRestartPrompt } from "@/lib/install/appUpdate";

/**
 * The primary surface of the in-app updater: once an update is downloaded
 * (and, on macOS/Linux, already installed), a title-bar button relaunches into
 * it. The modal is for the mode setting and the manual check; nothing needs a
 * click before this appears. The × hides it for this run only — the status
 * bar's indicator stays, so dismissing never makes an update unreachable.
 */
export function UpdateRestartButton() {
  const ready = useReadyUpdate();
  const dict = useDict().shell.titleBar;
  const { restart, restarting } = useRestartIntoUpdate();

  if (!ready || ready.dismissed) return null;

  return (
    <div className="flex h-[30px] min-w-0 shrink items-stretch border border-border text-xs text-primary">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={restarting}
            aria-label={dict.restartToUpdate}
            onClick={() => void restart()}
            className="flex cursor-pointer items-center gap-1.5 px-2 font-mono outline-hidden transition-colors hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
          >
            <ArrowUpCircle className="size-3.5" strokeWidth={1.5} />
            {dict.restartShort}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{dict.restartToUpdateHint.replace("{version}", ready.update.version)}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={dict.dismissRestartToUpdate}
        onClick={dismissRestartPrompt}
        className="flex w-6 cursor-pointer items-center justify-center border-l border-border text-muted-foreground outline-hidden transition-colors hover:bg-bg-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <X className="size-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}
