import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";
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
  // Several "Copy" buttons can share a screen; each says which command.
  const codeId = useId();
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
      <span className="shrink-0 font-mono text-[length:calc(12px*var(--font-scale-ratio))] text-primary" aria-hidden="true">
        $
      </span>
      <code id={codeId} className="selectable-content min-w-0 flex-1 font-mono text-[length:calc(12.5px*var(--font-scale-ratio))] leading-[1.6] break-all text-foreground">{command}</code>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleCopy()}
        aria-describedby={codeId}
        className="px-2.5 text-[length:calc(11px*var(--font-scale-ratio))] font-normal text-text-faint hover:bg-transparent"
      >
        <span aria-live="polite">{state === "idle" ? copy.copy : state === "copied" ? copy.copied : copy.failed}</span>
      </Button>
    </div>
  );
}
