import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VariantProps } from "class-variance-authority";
import { ArrowRight, Plus, Trash2, X } from "lucide-react";
import { Button, type buttonVariants } from "./button";
import { phoneScreenshot } from "@/components/chat/media/sampleMedia";

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type Size = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

// Records, not arrays, so that adding a variant or size to `buttonVariants`
// without listing it here is a compile error: the matrix stories below are
// the catalog, and a catalog that silently misses an entry is worse than none.
const VARIANTS = {
  default: true,
  destructive: true,
  "destructive-outline": true,
  outline: true,
  secondary: true,
  ghost: true,
  link: true,
  chrome: true,
  quiet: true,
  media: true,
} satisfies Record<Variant, true>;

const SIZES = {
  xs: "text",
  sm: "text",
  default: "text",
  lg: "text",
  inline: "text",
  bar: "text",
  toolbar: "text",
  "icon-xs": "icon",
  "icon-sm": "icon",
  icon: "icon",
  "icon-lg": "icon",
  media: "media",
} satisfies Record<Size, "text" | "icon" | "media">;

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
    loading: { control: "boolean" },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Delete session" },
};

/** A stop inside a card: outlined until pointed at. */
export const DestructiveOutline: Story = {
  args: { variant: "destructive-outline", size: "xs", children: "Stop agent" },
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

/** Window controls, strip and status bar buttons: a fill, never an outline. */
export const Chrome: Story = {
  args: { variant: "chrome", size: "icon", "aria-label": "Add", children: <Plus /> },
};

/** The × of a tab or a banner: only the glyph brightens. */
export const Quiet: Story = {
  args: { variant: "quiet", size: "icon-xs", "aria-label": "Close", children: <X /> },
};

/** Takes the size of the text around it — here a status bar's. */
export const Inline: Story = {
  args: { variant: "chrome", size: "inline", children: "v0.2.0" },
  render: (args) => (
    <div className="flex h-7 items-center bg-bg-chrome px-2 font-mono text-[11.5px] text-text-faint">
      <Button {...args} />
    </div>
  ),
};

/** A composer toolbar trigger: the chrome's sans, a fill while its menu is open. */
export const Toolbar: Story = {
  args: { variant: "chrome", size: "toolbar", children: "Bypass permissions" },
};

/** An action in a bar of them, like the room's selection bar. */
export const Bar: Story = {
  args: { variant: "chrome", size: "bar", children: "Group" },
};

/** A picture you open — a screenshot in a message. The tile has no box of
 * its own (`size="media"`): the picture inside sizes it. */
export const Media: Story = {
  args: { variant: "media", size: "media", "aria-label": "Open login.png" },
  render: (args) => (
    <Button {...args}>
      <img src={phoneScreenshot("Sign in", "royalblue")} alt="" className="h-40 w-auto" />
    </Button>
  ),
};

/** A strip of them, as the media viewer lays its thumbnails: the one on
 * show is pressed, framed twice as heavy in the full ink. */
export const MediaStrip: Story = {
  args: { variant: "media", size: "media" },
  render: (args) => (
    <div className="flex gap-1.5">
      {(["Sign in", "Home", "Settings"] as const).map((title, index) => (
        <Button key={title} {...args} aria-pressed={index === 1} aria-label={`Open ${title}`}>
          <img src={phoneScreenshot(title, "royalblue")} alt="" className="h-12 w-auto" />
        </Button>
      ))}
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
};

/** Same width as idle: the label stays in place, invisible, under the spinner. */
export const Loading: Story = {
  args: { loading: true },
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

/** Every variant at every size, disabled and loading — the whole catalog on one screen. */
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
          <Button variant={variant} loading>
            loading
          </Button>
        </div>
      ))}
    </div>
  ),
};
