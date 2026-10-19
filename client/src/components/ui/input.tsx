import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The one field style in the app: squared off, sitting on the surface below
 * the panel it lives in (the same relationship the design gives every
 * input), and adopting the accent only on focus.
 *
 * Mono, not sans: every field in this app holds an identifier rather than
 * prose — a path, a profile name, a file name, a URL, a block of theme
 * JSON — and those are exactly what the typographic rule assigns to the
 * mono face. A field that ever holds a sentence can override it.
 */
function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "min-w-0 border border-border bg-bg-chrome px-2.5 py-1.5 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-text-faint focus:border-primary disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-w-0 resize-none border border-border bg-bg-chrome px-2.5 py-2 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-text-faint focus:border-primary disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Input, Textarea }
