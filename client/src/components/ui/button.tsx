import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Controls are mono, square and dense — that is the brand, not a style
 * preference: every control label in the design is IBM Plex Mono, and the sans
 * face is reserved for prose (message content, descriptions) and the display
 * face for titles.
 *
 * Two structural choices worth knowing before editing:
 *
 * - The base carries `border border-transparent`, so the variants that grow a
 *   border on hover don't shift their own layout by a pixel when they do.
 * - `transition-colors`, never `transition-all`. `all` includes layout
 *   properties, and a button is the single most repeated element in the app —
 *   this is the first place a careless transition costs frames.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 border border-transparent font-mono font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Light fill, dark ink: the accent colour is reserved for "needs
        // you", so the default action is the foreground ramp inverted.
        default: "border-foreground bg-foreground text-background hover:border-muted-foreground hover:bg-muted-foreground",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground hover:border-destructive-hover hover:bg-destructive-hover focus-visible:ring-destructive/50",
        // The design's default control: an outline that only commits to a
        // border color, and firms up on hover rather than filling in.
        outline: "border-border text-muted-foreground hover:border-text-faint hover:bg-bg-elevated hover:text-foreground",
        secondary: "border-border bg-bg-elevated text-foreground hover:bg-surface-hover",
        // Chrome buttons (title bar, panel headers): invisible until pointed
        // at, then they acquire the outline variant's look.
        ghost: "text-muted-foreground hover:border-border hover:bg-bg-elevated hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-2 px-3.5 text-xs",
        xs: "h-6 gap-1 px-2 text-[10.5px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-3 text-[11.5px]",
        lg: "h-9 px-5 text-[13px]",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
