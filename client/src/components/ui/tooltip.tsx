import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// `disableHoverableContent`: Radix keeps a tooltip open while the pointer
// crosses the gap to the bubble (WCAG 1.4.13 "hoverable"), which is right for
// rich popovers but wrong for plain labels: the bubble would linger while the
// pointer rests between it and the trigger. Ours are text-only labels with
// nothing to click, so leaving the trigger closes them.
function TooltipProvider({
  delayDuration = 400,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event)
        // Radix opens on any focus. A click (or code moving focus after one,
        // like selecting a tab) is not a keyboard visit, and the tooltip
        // would pop up on a trigger the person just used. `:focus-visible`
        // is what the browser already uses to tell the two apart; a
        // prevented default makes Radix skip its own open.
        if (!(event.target as Element).matches(":focus-visible")) event.preventDefault()
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Inverted: the foreground ramp as the fill and the page color as
          // the ink, so it stands out from anything behind it — including a
          // neighbouring menu (real finding: the slash commands menu's
          // tooltip was almost invisible next to the listing itself).
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) bg-foreground px-2.5 py-1.5 font-mono text-[11px] text-balance text-background shadow-popover",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

function TooltipShortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-2 border border-background/25 px-1 opacity-70">{children}</span>
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipShortcut }
