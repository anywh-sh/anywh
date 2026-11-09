import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * An on/off control for a setting that applies the moment it changes. Squared
 * off like the rest of `ui/`: a bordered track with a block for a thumb, the
 * accent colour only when on. Radix for the same reason as `Checkbox` — the
 * native control looks different in each of the three webviews, and the
 * primitive carries the `role="switch"`/`aria-checked` semantics.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center border border-border bg-bg-chrome p-0.5 outline-none transition-colors focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 bg-text-faint transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
