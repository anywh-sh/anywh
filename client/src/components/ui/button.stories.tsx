import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VariantProps } from "class-variance-authority";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button, type buttonVariants } from "./button";

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type Size = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

// Records, not arrays, so that adding a variant or size to `buttonVariants`
// without listing it here is a compile error: the matrix stories below are
// the catalog, and a catalog that silently misses an entry is worse than none.
const VARIANTS = {
  default: true,
  destructive: true,
  outline: true,
  secondary: true,
  ghost: true,
  link: true,
} satisfies Record<Variant, true>;

const SIZES = {
  xs: "text",
  sm: "text",
  default: "text",
  lg: "text",
  "icon-xs": "icon",
  "icon-sm": "icon",
  icon: "icon",
  "icon-lg": "icon",
} satisfies Record<Size, "text" | "icon">;

export const variants = Object.keys(VARIANTS) as Variant[];
export const textSizes = (Object.keys(SIZES) as Size[]).filter((size) => SIZES[size] === "text");
export const iconSizes = (Object.keys(SIZES) as Size[]).filter((size) => SIZES[size] === "icon");

const meta = {
  title: "Primitives/Button",
  component: Button,
  // The lowercase exports above are data for the matrix and the tests, not stories.
  excludeStories: /^[a-z]/,
  args: { children: "Continue" },
  argTypes: {
    variant: { control: "select", options: variants },
    size: { control: "select", options: [...textSizes, ...iconSizes] },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Delete session" },
};

export const Outline: Story = {
  args: { variant: "outline" },
};

export const Secondary: Story = {
  args: { variant: "secondary" },
};

export const Ghost: Story = {
  args: { variant: "ghost" },
};

export const Link: Story = {
  args: { variant: "link", children: "Learn more" },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const WithIcon: Story = {
  args: {
    children: (
      <>
        Next <ArrowRight />
      </>
    ),
  },
};

export const IconOnly: Story = {
  args: { size: "icon", variant: "ghost", "aria-label": "Add", children: <Plus /> },
};

/** `asChild` hands the styling to the child element — here an anchor. */
export const AsChild: Story = {
  args: {
    asChild: true,
    variant: "outline",
    children: <a href="https://anywh.sh">anywh.sh</a>,
  },
};

/** Every variant at every text size, plus the icon sizes — the whole catalog on one screen. */
export const Matrix: Story = {
  parameters: { layout: "padded" },
  render: () => (
    <div className="grid gap-3">
      {variants.map((variant) => (
        <div key={variant} className="flex items-center gap-3">
          <span className="w-24 font-mono text-xs text-text-faint">{variant}</span>
          {textSizes.map((size) => (
            <Button key={size} variant={variant} size={size}>
              {size}
            </Button>
          ))}
          {iconSizes.map((size) => (
            <Button key={size} variant={variant} size={size} aria-label={`${variant} ${size}`}>
              {variant === "destructive" ? <Trash2 /> : <Plus />}
            </Button>
          ))}
          <Button variant={variant} disabled>
            disabled
          </Button>
        </div>
      ))}
    </div>
  ),
};
