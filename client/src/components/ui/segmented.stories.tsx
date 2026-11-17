import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { LayoutGrid, MessageSquare } from "lucide-react";
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

function WithIconsExample() {
  const [value, setValue] = useState<"chat" | "room">("chat");
  return (
    <Segmented
      id="story-icons"
      kind="radio"
      label="Session type"
      value={value}
      onChange={setValue}
      options={[
        { value: "chat", label: "Conversation", icon: <MessageSquare className="size-3.5" /> },
        { value: "room", label: "Room", icon: <LayoutGrid className="size-3.5" /> },
      ]}
    />
  );
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

/** With an icon before each label. */
export const WithIcons: Story = {
  render: () => <WithIconsExample />,
};

/** Sets a value; nothing below changes. */
export const Radio: Story = {
  args: { kind: "radio" },
};
