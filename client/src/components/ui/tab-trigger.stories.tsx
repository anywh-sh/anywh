import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { X } from "lucide-react";
import { handleRovingKeyDown } from "@/lib/rovingKeys";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { TabTrigger } from "./tab-trigger";

export const tabLabels = ["Terminal 1", "Terminal 2", "Terminal 3"];

/**
 * A strip the way the app draws one: the wrapper owns the look, the trigger
 * the semantics, and the × sits beside the trigger rather than inside it.
 */
function Strip({ closable = false }: { closable?: boolean }) {
  const [active, setActive] = useState(tabLabels[0]);
  return (
    <div role="tablist" aria-label="Terminals" onKeyDown={(event) => handleRovingKeyDown(event, "tab")} className="flex h-8 items-stretch">
      {tabLabels.map((label) => (
        <div
          key={label}
          className={cn(
            "relative flex items-center border-r border-border-soft font-mono text-[11px]",
            label === active ? "bg-bg-elevated text-foreground shadow-[inset_0_-2px_0_var(--primary)]" : "text-muted-foreground hover:bg-surface-hover",
          )}
        >
          <TabTrigger selected={label === active} onClick={() => setActive(label)} className={cn("flex h-full items-center pl-2.5", closable ? "pr-[26px]" : "pr-2.5")}>
            {label}
          </TabTrigger>
          {closable && (
            <Button variant="quiet" size="icon-xs" aria-label={`Close ${label}`} className="absolute right-1.5 size-4">
              <X className="size-3" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: "Primitives/TabTrigger",
  component: Strip,
  excludeStories: /^[a-z]/,
} satisfies Meta<typeof Strip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** With the × each tab of the app carries, as the trigger's sibling. */
export const Closable: Story = {
  args: { closable: true },
};
