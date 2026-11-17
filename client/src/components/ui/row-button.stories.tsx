import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VariantProps } from "class-variance-authority";
import { Plus, Search, SquareTerminal } from "lucide-react";
import { RowButton, type rowButtonVariants } from "./row-button";

type Tone = NonNullable<VariantProps<typeof rowButtonVariants>["tone"]>;
type Size = NonNullable<VariantProps<typeof rowButtonVariants>["size"]>;

// Records, so a tone or size added to `rowButtonVariants` without a story
// here is a compile error (same reasoning as button.stories.tsx).
const TONES = { default: true, faint: true } satisfies Record<Tone, true>;
const SIZES = { default: true, lg: true, auto: true } satisfies Record<Size, true>;

export const tones = Object.keys(TONES) as Tone[];
export const sizes = Object.keys(SIZES) as Size[];

const meta = {
  title: "Primitives/RowButton",
  component: RowButton,
  excludeStories: /^[a-z]/,
  args: {
    children: (
      <>
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1">Search</span>
      </>
    ),
  },
  argTypes: {
    tone: { control: "select", options: tones },
    size: { control: "select", options: sizes },
    selected: { control: "boolean" },
    mark: { control: "select", options: [undefined, "start", "end"] },
  },
  // Rows live on the sidebar's ground, at its width.
  decorators: [
    (Story) => (
      <div className="w-64 bg-bg-sidebar p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RowButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The row on screen: raised, with the bar on the sidebar's edge. */
export const Selected: Story = {
  args: {
    selected: true,
    mark: "start",
    children: (
      <>
        <Plus className="size-3.5 shrink-0" />
        <span className="flex-1">New conversation</span>
      </>
    ),
  },
};

/** A group heading or "older in search": dimmer, no fill on hover. */
export const Faint: Story = {
  args: { tone: "faint", children: <span>Older conversations in search</span> },
};

export const Large: Story = {
  args: { size: "lg", children: <span className="flex-1 truncate">A session title, on touch</span> },
};

/** The side panel's rail: icon only, centred, the bar on the window's edge. */
export const Rail: Story = {
  args: { selected: true, mark: "end", "aria-label": "Close terminal", className: "h-9 justify-center px-0", children: <SquareTerminal className="size-4" /> },
  decorators: [
    (Story) => (
      <div className="w-10">
        <Story />
      </div>
    ),
  ],
};

export const Disabled: Story = {
  args: { disabled: true },
};

/** Every tone at every size, selected or not. */
export const Matrix: Story = {
  render: () => (
    <div className="grid gap-1">
      {tones.flatMap((tone) =>
        sizes.flatMap((size) =>
          [false, true].map((selected) => (
            <RowButton key={`${tone}-${size}-${String(selected)}`} tone={tone} size={size} selected={selected} mark="start">
              <span className="flex-1">
                {tone} · {size}
                {selected ? " · selected" : ""}
              </span>
            </RowButton>
          )),
        ),
      )}
    </div>
  ),
};
