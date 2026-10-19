"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Squared off like every other control here — no rounding, border on the
 * surface, accent only when checked, matching `Input`'s relationship to
 * the panel it sits in.
 *
 * Radix rather than a bare `<input type="checkbox">` for the same reason
 * the rest of `ui/` is Radix: the native control can't be styled
 * consistently across the three webviews this app ships in, and its
 * indeterminate state and label association are exactly the parts that
 * break silently when hand-rolled. The primitive comes from the `radix-ui`
 * umbrella package already in use — no new dependency.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 border border-border bg-bg-chrome outline-none transition-colors focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current">
        <CheckIcon className="size-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
