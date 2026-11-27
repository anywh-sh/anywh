import type { Meta, StoryObj } from "@storybook/react-vite";
import type { VariantProps } from "class-variance-authority";
import { useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, type dialogContentVariants } from "./dialog";
import { Input } from "./input";
import { landscapeChart } from "@/components/chat/media/sampleMedia";

type Size = NonNullable<VariantProps<typeof dialogContentVariants>["size"]>;

// A Record, not an array, so that adding a size to `dialogContentVariants`
// without listing it here is a compile error (see button.stories.tsx). No
// matrix of sizes side by side: a dialog is modal, one on screen at a time,
// so each size is its own story and the test opens every one.
const SIZES = {
  default: "Fits its content, up to a form's width; opens and closes at once.",
  large: "A frame over almost the whole window, a margin all round; grows in and fades out.",
} satisfies Record<Size, string>;

export const sizes = Object.keys(SIZES) as Size[];

interface ExampleProps {
  size?: Size;
  title?: string;
  children?: ReactNode;
}

/** A dialog with the state its owner keeps: open at first, and once closed,
 * a button to open it again — which is how to watch it come and go. */
function Example({ size = "default", title = "Rename session", children }: ExampleProps) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open the dialog
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size={size} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {children ?? (
            <>
              <DialogBody>
                <Input defaultValue="Run the sign-in flow on the simulator" aria-label="Name" />
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setOpen(false)}>Save</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const meta = {
  title: "Primitives/Dialog",
  component: Example,
  // The lowercase exports above are data for the tests, not stories.
  excludeStories: /^[a-z]/,
  argTypes: {
    size: { control: "select", options: sizes },
  },
} satisfies Meta<typeof Example>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A form: the header band, a padded body, the footer's actions. */
export const Default: Story = {
  args: { size: "default" },
};

/** Room for what it shows — here a picture, edge to edge under the band. */
export const Large: Story = {
  args: {
    size: "large",
    title: "Requests per day",
    children: (
      <div className="flex min-h-0 flex-1 bg-background p-6">
        <img src={landscapeChart("Requests per day")} alt="Requests per day" className="m-auto max-h-full max-w-full" />
      </div>
    ),
  },
};
