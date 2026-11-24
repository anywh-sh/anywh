import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotPaneToggleButton } from "@/components/bots/BotPaneToggleButton";
import { TooltipProvider } from "@/components/ui/tooltip";

const meta = {
  title: "Bots/Pane toggle",
  component: BotPaneToggleButton,
  args: { open: false, onToggle: () => undefined },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="flex w-10 flex-col border-l border-border bg-bg-sidebar">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof BotPaneToggleButton>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing waiting on the person. */
export const Closed: Story = {};

/** A task waits on the person: a dot on the icon, with the panel closed. */
export const NeedsYou: Story = { args: { attention: true } };

/** The panel on screen, a task still waiting. */
export const OpenNeedsYou: Story = { args: { open: true, attention: true } };
