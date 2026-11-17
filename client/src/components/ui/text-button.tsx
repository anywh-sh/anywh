import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * A button that reads as text: "show all", "3 more", a disclosure toggle in
 * a block's header, a path in a message, an arrow between questions. No
 * box, no padding, no font of its own — it takes the face and size of the
 * text it sits in, and only its ink changes on hover. A `Button` is a
 * control with a shape; this is the word you click.
 *
 * - `tone` is the ink and what it brightens to. `none` leaves both to the
 *   caller (a prose class that already draws the link).
 * - Display is the caller's: inline by default, `flex` when it lays out an
 *   icon and a label.
 */
const textButtonVariants = cva(
  "cursor-pointer text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      tone: {
        // Secondary text that comes forward.
        muted: "text-muted-foreground hover:text-foreground",
        // Faint text that comes all the way forward.
        faint: "text-text-faint hover:text-foreground",
        // Faint text that only steps up one level, for toggles that should
        // stay quiet even when pointed at.
        dim: "text-text-faint hover:text-muted-foreground",
        // A cancel or remove that warns on hover.
        destructive: "text-muted-foreground hover:text-destructive",
        none: "",
      },
    },
    defaultVariants: {
      tone: "muted",
    },
  }
)

function TextButton({
  className,
  tone = "muted",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof textButtonVariants>) {
  return (
    <button
      type={type}
      data-slot="text-button"
      data-tone={tone}
      className={cn(textButtonVariants({ tone, className }))}
      {...props}
    />
  )
}

export { TextButton, textButtonVariants }
