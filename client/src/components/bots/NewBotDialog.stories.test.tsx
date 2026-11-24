import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { createBot } from "@/lib/bots/botClient";

// A creation that never answers: the form stays in its busy state.
vi.mock("@/lib/bots/botClient", async (original) => ({ ...(await original<object>()), createBot: vi.fn(() => new Promise(() => undefined)) }));
import * as stories from "./NewBotDialog.stories";

const { Blank, FromTemplate } = composeStories(stories);
const copy = en.bots;
const face = (): string | null | undefined => document.querySelector(`[aria-label="${copy.create.changeMascot}"] [data-mascot]`)?.getAttribute("data-mascot");

describe("New bot dialog stories", () => {
  afterEach(() => {
    act(() => cleanup());
    vi.mocked(createBot).mockClear();
  });

  it("from scratch, it can only be created once it has a name and says who it is", async () => {
    render(<Blank />);
    const create = screen.getByRole("button", { name: new RegExp(`^${copy.create.create}`) });
    expect(create).toBeDisabled();
    expect(face()).toBe("bip:sand");
    await userEvent.type(screen.getByLabelText(copy.create.namePlaceholder), "Deploys");
    await userEvent.type(screen.getByPlaceholderText(copy.create.soulPlaceholder), "I watch the deploys.");
    expect(create).toBeEnabled();
    expect(screen.queryByText(copy.create.readOnly)).toBeNull();
  });

  it("from a template, it comes filled in with the template's face, read-only, its schedule off until turned on", async () => {
    render(<FromTemplate />);
    expect(screen.getByDisplayValue(copy.templates["ci-check"].name)).toBeInTheDocument();
    expect((screen.getByPlaceholderText<HTMLTextAreaElement>(copy.create.soulPlaceholder)).value).toBe(copy.templates["ci-check"].soul);
    expect(face()).toBe("bip:sand");
    expect(screen.getByText(copy.create.readOnly)).toBeInTheDocument();
    const schedule = screen.getByRole("switch", { name: copy.templates["ci-check"].scheduleName });
    expect(screen.getByText(copy.create.scheduleOff.replace("{when}", copy.templates["ci-check"].when))).toBeInTheDocument();
    await userEvent.click(schedule);
    expect(screen.getByText(copy.create.scheduleOn.replace("{when}", copy.templates["ci-check"].when))).toBeInTheDocument();
  });

  it("the mascot's words open the picker, and a pick changes the face", async () => {
    render(<FromTemplate />);
    await userEvent.click(screen.getByRole("button", { name: `${copy.mascot.characters.bip} · ${copy.mascot.tones.sand} · ${copy.mascot.change}` }));
    expect(await screen.findByTestId("mascot-picker")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: copy.mascot.next }));
    await userEvent.click(screen.getByRole("radio", { name: copy.mascot.tones.stone }));
    expect(face()).toBe("visor:stone");
  });

  it("⌘/Ctrl+Enter creates even when focus has left the form", async () => {
    render(<Blank />);
    await userEvent.type(screen.getByLabelText(copy.create.namePlaceholder), "Deploys");
    await userEvent.type(screen.getByPlaceholderText(copy.create.soulPlaceholder), "I watch the deploys.");
    // What WebKit does after a click on a switch or on the form's blank space.
    act(() => (document.activeElement as HTMLElement).blur());
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(createBot).toHaveBeenCalledTimes(1);
  });

  it("while creating, the button keeps its label and the whole form is locked", async () => {
    render(<FromTemplate />);
    const create = screen.getByRole("button", { name: new RegExp(`^${copy.create.create}`) });
    await userEvent.click(create);
    expect(create).toHaveAttribute("aria-busy", "true");
    expect(create).toBeDisabled();
    expect(create).toHaveTextContent(copy.create.create);
    expect(screen.getByDisplayValue(copy.templates["ci-check"].name)).toBeDisabled();
    expect(screen.getByRole("switch", { name: copy.templates["ci-check"].scheduleName })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.common.cancel })).toBeDisabled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(createBot).toHaveBeenCalledTimes(1);
  });
});
