import type { Meta, StoryObj } from "@storybook/react-vite";
import { Mascot } from "@/components/bots/Mascot";
import { MASCOT_ORDER, MASCOT_TONE_ORDER, type MascotState } from "@/lib/bots/mascot";

const STATES: MascotState[] = ["idle", "working", "needsYou", "paused", "setup", "failed", "limit"];

const meta = {
  title: "Bots/Mascot",
  component: Mascot,
  args: { mascot: { character: "bip", tone: "areia" }, state: "idle", size: 64 },
} satisfies Meta<typeof Mascot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Every character in its own tone and every state, large and as the sidebar
 * draws it (32 px, with its corner mark). */
export const Sheet: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {STATES.map((state) => (
        <div key={state} className="flex items-center gap-4" data-state={state}>
          <span className="w-24 font-mono text-[11px] text-text-faint">{state}</span>
          {MASCOT_ORDER.map((character) => (
            <span key={character} className="flex items-end gap-2">
              <Mascot mascot={{ character, tone: "giz" }} state={state} size={48} />
            </span>
          ))}
          <Mascot mascot={{ character: "bip", tone: "areia" }} state={state} size={32} badge backdrop="var(--background)" />
        </div>
      ))}
    </div>
  ),
};

/** One character in the eight tones. */
export const Tones: Story = {
  render: () => (
    <div className="flex gap-4">
      {MASCOT_TONE_ORDER.map((tone) => (
        <div key={tone} className="flex flex-col items-center gap-1">
          <Mascot mascot={{ character: "fone", tone }} size={48} title={tone} />
          <span className="font-mono text-[11px] text-text-faint">{tone}</span>
        </div>
      ))}
    </div>
  ),
};

/** The sizes the app uses, all multiples of 16. */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {[16, 32, 48, 64, 96, 128].map((size) => (
        <Mascot key={size} mascot={{ character: "oculos", tone: "giz" }} size={size} />
      ))}
    </div>
  ),
};
