import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dialog } from "@/components/ui/dialog";
import { NewBotForm } from "@/components/bots/NewBotDialog";
import { storyProfile } from "@/components/bots/botStoryData";
import type { Profile } from "@/lib/profiles/profiles";

const workProfile: Profile = { id: "story-work", label: "Work", host: "10.0.0.7", relayPort: 1 };

const meta = {
  title: "Bots/New bot",
  component: NewBotForm,
  args: { request: { profileId: storyProfile.id }, onCreated: () => undefined, onTemplates: () => undefined, agents: ["claude", "codex"], profiles: [storyProfile, workProfile] },
  decorators: [
    // The form's title and close button belong to a dialog; drawn in place
    // here, without the overlay.
    (Story) => (
      <Dialog open modal={false}>
        <div className="w-[600px] border border-border bg-bg-sidebar shadow-popover">
          <Story />
        </div>
      </Dialog>
    ),
  ],
} satisfies Meta<typeof NewBotForm>;
export default meta;
type Story = StoryObj<typeof meta>;

/** From scratch: a face to pick, a name and who it is to write. */
export const Blank: Story = {};

/** From a template: everything filled in, starting read-only with its schedule off. */
export const FromTemplate: Story = { args: { request: { profileId: storyProfile.id, templateId: "ci-check" } } };
