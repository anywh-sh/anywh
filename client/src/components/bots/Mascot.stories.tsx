import type { Meta, StoryObj } from "@storybook/react-vite";
import { Mascot } from "@/components/bots/Mascot";
import type { MascotState } from "@/lib/bots/mascot";

const STATES: MascotState[] = ["idle", "working", "needsYou", "paused", "setup", "failed"];
const NAMES = ["Vigia", "Revisor", "Standup", "Faxina", "Docs", "Triagem", "Mabel", "Otto", "Lumi", "Brisa", "Cora", "Pixel"];

const meta = {
  title: "Bots/Mascot",
  component: Mascot,
  args: { seed: "Vigia", state: "idle", size: 48 },
} satisfies Meta<typeof Mascot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Every state of one face, large and as the sidebar draws it (with its badge). */
export const States: Story = {
  render: () => (
    <div className="flex gap-6">
      {STATES.map((state) => (
        <div key={state} className="flex flex-col items-center gap-2" data-state={state}>
          <Mascot seed="Vigia" state={state} size={48} />
          <Mascot seed="Vigia" state={state} size={24} badge />
          <span className="font-mono text-[11px] text-text-faint">{state}</span>
        </div>
      ))}
    </div>
  ),
};

/** Faces generated from names alone. */
export const Names: Story = {
  render: () => (
    <div className="grid grid-cols-6 gap-4">
      {NAMES.map((name) => (
        <div key={name} className="flex flex-col items-center gap-1">
          <Mascot seed={name} size={48} title={name} />
          <span className="font-mono text-[11px] text-text-faint">{name}</span>
        </div>
      ))}
    </div>
  ),
};

/** The sizes the app uses: 12 (a folded heading), 24 (sidebar), 36 (panel), 96 (creation). */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {[12, 24, 36, 48, 96].map((size) => (
        <Mascot key={size} seed="Standup" size={size} />
      ))}
    </div>
  ),
};
