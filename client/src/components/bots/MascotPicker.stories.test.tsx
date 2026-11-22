import { composeStories } from "@storybook/react-vite";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import * as stories from "./MascotPicker.stories";

const { Panel, OtherTone, FromFrame } = composeStories(stories);
const copy = en.bots.mascot;
const current = (): string | null | undefined => document.querySelector('[data-mascot] svg[width="96"]')?.closest("[data-mascot]")?.getAttribute("data-mascot");

describe("MascotPicker stories", () => {
  afterEach(() => act(() => cleanup()));

  it("walking the characters brings each one's own tone; a tone then changes only the color", async () => {
    render(<Panel />);
    expect(current()).toBe("bip:areia");
    await userEvent.click(screen.getByRole("button", { name: copy.next }));
    expect(current()).toBe("visor:giz");
    expect(screen.getByRole("radio", { name: copy.tones.giz })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: copy.tones.rosa }));
    expect(current()).toBe("visor:rosa");
    await userEvent.click(screen.getByRole("button", { name: copy.previous }));
    await userEvent.click(screen.getByRole("button", { name: copy.previous }));
    expect(current()).toBe("helice:giz");
  });

  it("the faded faces at the sides pick their character too, and the face slides in from that side", async () => {
    const { container } = render(<Panel />);
    await userEvent.click(screen.getByRole("button", { name: copy.characters.visor }));
    expect(current()).toBe("visor:giz");
    expect(container.querySelector("[data-carousel-dir]")?.getAttribute("data-carousel-dir")).toBe("next");
    await userEvent.click(screen.getByRole("button", { name: copy.characters.bip }));
    expect(current()).toBe("bip:areia");
    expect(container.querySelector("[data-carousel-dir]")?.getAttribute("data-carousel-dir")).toBe("prev");
  });

  it("the arrow keys walk the characters too", () => {
    render(<OtherTone />);
    const panel = screen.getByRole("radiogroup").parentElement!;
    fireEvent.keyDown(panel, { key: "ArrowRight" });
    expect(current()).toBe("oculos:oliva");
    fireEvent.keyDown(panel, { key: "ArrowLeft" });
    expect(current()).toBe("tela:ardosia");
  });

  it("opens from its trigger and closes on Escape", async () => {
    render(<FromFrame />);
    expect(screen.queryByTestId("mascot-picker")).toBeNull();
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByTestId("mascot-picker")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("mascot-picker")).toBeNull();
  });
});
