import { ArrowUpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
          <Button
            variant="chrome"
            size="inline"
            loading={restarting}
            aria-label={dict.restartToUpdate}
            onClick={() => void restart()}
            className="h-auto px-2 py-0 text-primary hover:bg-bg-elevated hover:text-primary"
          >
            <ArrowUpCircle className="size-3.5" strokeWidth={1.5} />
            {dict.restartShort}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{dict.restartToUpdateHint.replace("{version}", ready.update.version)}</TooltipContent>
      </Tooltip>
      <Button
        variant="chrome"
        size="icon-xs"
        aria-label={dict.dismissRestartToUpdate}
        onClick={dismissRestartPrompt}
        className="h-auto border-l-border hover:bg-bg-elevated"
      >
        <X className="size-3" strokeWidth={1.5} />
      </Button>
    </div>
  );
}
