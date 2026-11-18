import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./AddProfileDialog.stories";
import { en } from "@/i18n/en";

const copy = en.shell.profiles.add;
const { Simulated, SignedOut } = composeStories(stories);

describe("AddProfileDialog stories", () => {
  afterEach(() => cleanup());

  it("Simulated walks from the name to a confirmed account", async () => {
    const user = userEvent.setup();
    render(<Simulated />);
    const body = within(document.body);
    await user.type(await body.findByLabelText(copy.nameLabel), "Client X");
    await user.click(body.getByRole("button", { name: copy.continue }));
    expect(await screen.findByText(/work@example.com/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(body.getByRole("button", { name: en.common.create })).toBeEnabled();
  });

  it("SignedOut offers to connect the agent", async () => {
    const user = userEvent.setup();
    render(<SignedOut />);
    const body = within(document.body);
    await user.type(await body.findByLabelText(copy.nameLabel), "Client X");
    await user.click(body.getByRole("button", { name: copy.continue }));
    expect(await body.findByRole("button", { name: copy.connect }, { timeout: 3000 })).toBeInTheDocument();
  });
});
