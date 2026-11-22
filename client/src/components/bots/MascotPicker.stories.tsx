import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { Mascot } from "@/components/bots/Mascot";
import { MascotPicker, MascotPickerPanel } from "@/components/bots/MascotPicker";
import type { MascotChoice } from "@/lib/bots/mascot";

function Controlled({ initial, popover }: { initial: MascotChoice; popover?: boolean }) {
  const [value, setValue] = useState(initial);
  if (!popover) {
    return (
      <div className="w-[360px] border border-border bg-background shadow-popover">
        <MascotPickerPanel value={value} onChange={setValue} />
      </div>
    );
  }
  return (
    <MascotPicker value={value} onChange={setValue}>
      <Button variant="outline" size="icon-lg" className="size-24">
        <Mascot mascot={value} size={64} />
      </Button>
    </MascotPicker>
  );
}

const meta = {
  title: "Bots/Mascot picker",
  component: Controlled,
  args: { initial: { character: "bip", tone: "areia" } },
} satisfies Meta<typeof Controlled>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The panel on its own: the carousel and the tones. */
export const Panel: Story = {};

/** A character in a tone other than its own. */
export const OtherTone: Story = { args: { initial: { character: "tela", tone: "rosa" } } };

/** As the new bot dialog opens it, from the mascot's frame. */
export const FromFrame: Story = { args: { popover: true } };
