import { useEffect, useRef, useState } from "react";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * A shell command the reader is meant to paste: `$`, the command, and a
 * Copy chip that turns into "Copied" for 1.5 s. `$` is the accent's only
 * job here, next to the mark. A refused clipboard write (some webviews, no
 * permission) shows the failure word instead of pretending it worked.
 */
export function CommandLine({ command, className }: { command: string; className?: string }) {
  const copy = useDict().firstRun.copy;
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }

  return (
    <div className={cn("flex min-h-9 items-center gap-2.5 border border-border-soft bg-bg-chrome py-1 pr-1 pl-3", className)}>
      <span className="shrink-0 font-mono text-[12px] text-primary" aria-hidden="true">
        $
      </span>
      <code className="selectable-content min-w-0 flex-1 font-mono text-[12.5px] leading-[1.6] break-all text-foreground">{command}</code>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="h-7 shrink-0 cursor-pointer border border-border px-2.5 font-mono text-[11px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline"
      >
        <span aria-live="polite">{state === "idle" ? copy.copy : state === "copied" ? copy.copied : copy.failed}</span>
      </button>
    </div>
  );
}
