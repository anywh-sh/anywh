/**
 * Shared look of the composer toolbar's dropdown triggers: no box, just mono
 * text (or an icon) that brightens on hover/open. The `·` between controls is
 * a pseudo-element on every trigger but the row's first, so whichever
 * controls actually render (the agent picker and model button are
 * conditional) still get separated without the row knowing which are present.
 */
export const toolbarTriggerClass =
  "relative flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1 font-mono text-[11.5px] text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground disabled:cursor-default disabled:opacity-50 not-first:before:absolute not-first:before:-left-2.5 not-first:before:text-text-faint not-first:before:content-['·']";
