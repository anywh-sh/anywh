import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * The eyebrow-style tag the design uses for short status words next to a name
 * — LOCAL/REMOTE/REVOGADO on a profile, the tool name on a tool call. Tiny,
 * mono, uppercase and letter-spaced, so it reads as metadata rather than as
 * content; pass the label in whatever case, the component uppercases it.
 *
 * Square, like every other control: the pill shape the shadcn default shipped
 * with belongs to a different design language than this one.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border border-transparent px-1.5 py-0.5 font-mono text-[9.5px] font-medium tracking-[0.09em] whitespace-nowrap uppercase transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary-hover",
        // Tinted rather than filled — for a tag that marks a property of the
        // thing it sits next to, not the thing itself.
        secondary: "border-border bg-primary-soft text-primary-ink [a&]:hover:bg-primary-soft",
        destructive: "border-destructive text-destructive [a&]:hover:bg-destructive/10",
        outline: "border-border text-text-faint [a&]:hover:border-text-faint [a&]:hover:text-foreground",
        ghost: "text-text-faint [a&]:hover:text-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  }
)

function Badge({
  className,
  variant = "outline",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
