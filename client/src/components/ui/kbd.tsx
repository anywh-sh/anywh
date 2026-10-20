import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One physical key, drawn as a key: 18px square (16 when `sm`), a heavier
 * bottom edge, mono. A shortcut is several of these side by side rather than
 * one string, so each key reads as its own cap.
 */
function Kbd({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"kbd"> & { size?: "default" | "sm" }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex items-center justify-center border border-b-2 border-border bg-bg-elevated px-1 font-mono text-[10.5px] leading-none font-medium text-muted-foreground",
        size === "sm" ? "h-4 min-w-4" : "h-[18px] min-w-[18px]",
        className
      )}
      {...props}
    />
  )
}

/** The keys of a shortcut, split the way the platform writes it — "⌘" and
 * "K" on macOS, "Ctrl" and "K" elsewhere. */
function KbdShortcut({ keys, className, size }: { keys: readonly string[]; className?: string; size?: "default" | "sm" }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-hidden="true">
      {keys.map((key) => (
        <Kbd key={key} size={size}>
          {key}
        </Kbd>
      ))}
    </span>
  )
}

export { Kbd, KbdShortcut }
