import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * The one loading indicator: a square-cornered app's only circle besides a
 * status dot. A ring with one lit edge, so it reads as "working" at 10px
 * without the visual weight of an icon.
 *
 * - Decorative by default (`aria-hidden`): what it sits beside carries the
 *   accessible name, or the busy control carries `aria-busy`. Pass `label`
 *   when the spinner is the only thing saying something is happening; it
 *   then becomes a `status`. A labelled spinner that repeats in a list (a
 *   tab, a session row) passes `role="img"` too: named, but not a live
 *   region announcing every row that starts working.
 * - The blanket `prefers-reduced-motion` rule in index.css already stills it.
 * - `tone="current"` follows the text color, which is what a spinner inside a
 *   filled `Button` needs; the others sit on the page.
 */
const spinnerVariants = cva("inline-block shrink-0 animate-spin rounded-full", {
  variants: {
    size: {
      xs: "size-2.5 border",
      sm: "size-3 border",
      md: "size-3.5 border-[1.5px]",
      lg: "size-4 border-[1.5px]",
    },
    tone: {
      // Neutral work in progress: a list row loading, a check running.
      default: "border-border border-t-foreground",
      // An agent running — the accent is reserved for "needs you" and "live".
      accent: "border-border border-t-primary",
      current: "border-current/25 border-t-current",
    },
  },
  defaultVariants: {
    size: "sm",
    tone: "default",
  },
})

function Spinner({
  className,
  size = "sm",
  tone = "default",
  label,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof spinnerVariants> & {
    label?: string
  }) {
  return (
    <span
      data-slot="spinner"
      data-size={size}
      data-tone={tone}
      {...(label === undefined ? { "aria-hidden": true } : { role: "status", "aria-label": label })}
      className={cn(spinnerVariants({ size, tone, className }))}
      {...props}
    />
  )
}

export { Spinner, spinnerVariants }
