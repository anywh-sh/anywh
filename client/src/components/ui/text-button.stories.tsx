import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VariantProps } from "class-variance-authority";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TextButton, type textButtonVariants } from "./text-button";

type Tone = NonNullable<VariantProps<typeof textButtonVariants>["tone"]>;

// A Record, so a tone added to `textButtonVariants` without a story here is a
// compile error (same reasoning as button.stories.tsx).
const TONES = { muted: true, faint: true, dim: true, destructive: true, none: true } satisfies Record<Tone, true>;

export const tones = Object.keys(TONES) as Tone[];

const meta = {
  title: "Primitives/TextButton",
  component: TextButton,
  excludeStories: /^[a-z]/,
  args: { children: "Show all" },
  argTypes: {
    tone: { control: "select", options: tones },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof TextButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** It takes the face and size of the text around it. */
export const InText: Story = {
  render: (args) => (
    <p className="font-mono text-[11px] text-text-faint">
      12 more lines · <TextButton {...args} tone="faint" />
    </p>
  ),
};

export const Destructive: Story = {
  args: { tone: "destructive", children: "Stop all" },
};

/** Icon only: the arrows between a card's questions. */
export const Icons: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <TextButton aria-label="Previous question" disabled>
        <ChevronLeft className="size-4" />
      </TextButton>
      <TextButton aria-label="Next question">
        <ChevronRight className="size-4" />
      </TextButton>
    </div>
  ),
};

/** Every tone, then disabled. */
export const Matrix: Story = {
  render: () => (
    <div className="grid gap-2 text-sm">
      {tones.map((tone) => (
        <TextButton key={tone} tone={tone}>
          {tone}
        </TextButton>
      ))}
      <TextButton disabled>disabled</TextButton>
    </div>
  ),
};
