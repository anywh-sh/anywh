import { useDict } from "@/i18n";

/**
 * What the side panel draws when it is open but nothing was picked in it: a
 * centred prompt to choose a view. It is the dock's "no selection" pane
 * (`none`), so a view added to the panel later is chosen from here without
 * the panel having to guess a default.
 */
export function DockEmptyState() {
  const dict = useDict();
  return (
    <div data-testid="dock-empty-state" className="flex h-full w-full items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
      {dict.panels.noSelection}
    </div>
  );
}
