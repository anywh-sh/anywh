import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * A clickable row of the app's chrome: the sidebar's search and new
 * conversation rows, a session in the list, a group heading, the side panel's
 * rail. Semantically a button, visually a row — the whole width, the label in
 * the sans face and left-aligned, the hover and the selected look running
 * edge to edge — which is why it is not a `Button` variant: a `Button` is a
 * mono, centred control.
 *
 * - `selected` raises the row to the elevated surface. With `mark`, the
 *   selected row also wears a 2px bar on that edge (`start` for the sidebar,
 *   `end` for the rail on the window's other side).
 * - `tone="faint"` is for secondary rows (a group heading, "older in
 *   search"): dimmer ink, and no fill on hover, only the ink brightening.
 * - `size="auto"` leaves the height and padding to the caller, for rows that
 *   are not the sidebar's: a card's header, a dialog's list. Off the
 *   sidebar's ground, pass that surface's fill (`hover:bg-surface-hover`).
 * - Children own their own colors where they need to (a session title that
 *   stays bright when unseen); the row's tone is the default ink.
 */
const rowButtonVariants = cva(
  "relative flex w-full shrink-0 cursor-pointer items-center gap-[9px] px-2 text-left text-[length:calc(13px*var(--chrome-scale))] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      tone: {
        default: "text-muted-foreground hover:text-foreground",
        faint: "text-text-faint hover:text-muted-foreground",
      },
      size: {
        default: "h-[30px]",
        lg: "min-h-11 py-2.5",
        // Padded by the caller: a card's header, a list inside a dialog.
        auto: "",
      },
      selected: {
        true: "bg-bg-elevated text-foreground hover:text-foreground",
        false: "",
      },
    },
    compoundVariants: [{ tone: "default", selected: false, className: "hover:bg-bg-hover" }],
    defaultVariants: {
      tone: "default",
      size: "default",
      selected: false,
    },
  }
)

function RowButton({
  className,
  tone = "default",
  size = "default",
  selected = false,
  mark,
  type = "button",
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof rowButtonVariants> & {
    mark?: "start" | "end"
  }) {
  return (
    <button
      type={type}
      data-slot="row-button"
      data-tone={tone}
      data-size={size}
      data-selected={selected || undefined}
      className={cn(rowButtonVariants({ tone, size, selected, className }))}
      {...props}
    >
      {selected && mark && (
        <span
          aria-hidden="true"
          data-slot="row-button-mark"
          className={cn("absolute inset-y-0 w-0.5 bg-muted-foreground", mark === "start" ? "left-0" : "right-0")}
        />
      )}
      {children}
    </button>
  )
}

export { RowButton, rowButtonVariants }
