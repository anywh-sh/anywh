import type { Meta, StoryObj } from "@storybook/react-vite";
import { AddRemoteMachineDialog } from "@/components/shell/AddRemoteMachineDialog";

const meta = {
  title: "Shell/AddRemoteMachineDialog",
  component: AddRemoteMachineDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: () => {} },
  decorators: [
    (Story) => (
      <div className="h-screen bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddRemoteMachineDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opens on the pairing code; the Address tab adds a machine by host and
 * port, the way the first run's Address tab does. */
export const Default: Story = {};
