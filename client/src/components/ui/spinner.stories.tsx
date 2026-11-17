import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VariantProps } from "class-variance-authority";
import { Spinner, type spinnerVariants } from "./spinner";

type Size = NonNullable<VariantProps<typeof spinnerVariants>["size"]>;
type Tone = NonNullable<VariantProps<typeof spinnerVariants>["tone"]>;

// Records so a new size or tone without a story entry fails tsc (see
// button.stories.tsx).
const SIZES = { xs: true, sm: true, md: true, lg: true } satisfies Record<Size, true>;
const TONES = { default: true, accent: true, current: true } satisfies Record<Tone, true>;

export const sizes = Object.keys(SIZES) as Size[];
export const tones = Object.keys(TONES) as Tone[];

const meta = {
  title: "Primitives/Spinner",
  component: Spinner,
  excludeStories: /^[a-z]/,
  argTypes: {
    size: { control: "select", options: sizes },
    tone: { control: "select", options: tones },
  },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Accent: Story = {
  args: { tone: "accent" },
};

/** With a `label` it stops being decorative and announces itself as a status. */
export const Labelled: Story = {
  args: { label: "Loading sessions", size: "md" },
};

/** Inline beside text, the way a list row or a status line uses it. */
export const BesideText: Story = {
  render: (args) => (
    <p className="flex items-center gap-2 text-xs text-text-faint">
      <Spinner {...args} />
      Waiting for the browser…
    </p>
  ),
};

export const Matrix: Story = {
  parameters: { layout: "padded" },
  render: () => (
    <div className="grid gap-3">
      {tones.map((tone) => (
        <div key={tone} className="flex items-center gap-4 text-muted-foreground">
          <span className="w-20 font-mono text-xs text-text-faint">{tone}</span>
          {sizes.map((size) => (
            <Spinner key={size} tone={tone} size={size} />
          ))}
        </div>
      ))}
    </div>
  ),
};
