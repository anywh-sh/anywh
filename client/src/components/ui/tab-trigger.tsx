import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The trigger of one tab in a strip of them (conversation tabs, terminal
 * tabs). Only the semantics and the shared states live here — `role="tab"`,
 * `aria-selected`, `data-state`, the roving `tabIndex` (only the selected
 * tab is in the Tab order; the strip's container moves focus with the arrow
 * keys) and the focus ring. The look is the strip's: a tab is drawn by its
 * wrapper (the top rule, the surface, the sibling ×), which a trigger can't
 * hold, since a button can't contain a button.
 */
function TabTrigger({
  selected,
  className,
  type = "button",
  ...props
}: Omit<React.ComponentProps<"button">, "role" | "aria-selected"> & { selected: boolean }) {
  return (
    <button
      type={type}
      role="tab"
      aria-selected={selected}
      data-slot="tab"
      data-state={selected ? "active" : "inactive"}
      tabIndex={selected ? 0 : -1}
      className={cn(
        "cursor-pointer outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { TabTrigger }
