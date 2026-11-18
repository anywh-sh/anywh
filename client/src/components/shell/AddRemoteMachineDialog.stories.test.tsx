import { composeStories } from "@storybook/react-vite";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./AddRemoteMachineDialog.stories";
import { en } from "@/i18n/en";

const copy = en.shell.profiles.pair;
const { Default } = composeStories(stories);

describe("AddRemoteMachineDialog stories", () => {
  afterEach(() => cleanup());

  it("Default switches between the pairing code and the address", async () => {
    const user = userEvent.setup();
    render(<Default />);
    const body = within(document.body);
    expect(body.getByLabelText(copy.codeLabel)).toBeInTheDocument();
    await user.click(body.getByRole("tab", { name: copy.modeAddress }));
    expect(body.getByLabelText(copy.hostLabel)).toBeInTheDocument();
    expect(body.queryByLabelText(copy.codeLabel)).not.toBeInTheDocument();
  });
});
