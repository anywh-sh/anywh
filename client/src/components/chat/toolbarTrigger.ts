/**
 * Shared look of the composer toolbar's dropdown triggers: no box, just mono
 * text (or an icon) that brightens on hover/open. Separation between controls
 * is the row's own gap, not a glyph, so whichever controls actually render
 * (the agent picker and model button are conditional) space out the same.
 */
export const toolbarTriggerClass =
  "flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1 font-mono text-[11.5px] text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground disabled:cursor-default disabled:opacity-50";
