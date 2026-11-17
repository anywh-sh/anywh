import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Segmented, type SegmentedOption } from "./segmented";

type Mode = "notify" | "auto-download" | "off";

export const options: SegmentedOption<Mode>[] = [
  { value: "notify", label: "Notify" },
  { value: "auto-download", label: "Install" },
  { value: "off", label: "Never" },
];

function Controlled({ kind }: { kind: "tabs" | "radio" }) {
  const [value, setValue] = useState<Mode>("notify");
  return <Segmented id={`story-${kind}`} kind={kind} label="Check for updates" value={value} options={options} onChange={setValue} />;
}

const meta = {
  title: "Primitives/Segmented",
  component: Controlled,
  excludeStories: /^[a-z]/,
  args: { kind: "tabs" },
  argTypes: { kind: { control: "inline-radio", options: ["tabs", "radio"] } },
} satisfies Meta<typeof Controlled>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each option swaps the panel below it. */
export const Tabs: Story = {};

/** Sets a value; nothing below changes. */
export const Radio: Story = {
  args: { kind: "radio" },
};
