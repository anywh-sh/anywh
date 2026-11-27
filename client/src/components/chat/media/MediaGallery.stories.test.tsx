import { composeStories } from "@storybook/react-vite";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { SAMPLE_FILES } from "./sampleMedia";
import * as stories from "./MediaGallery.stories";

const copy = en.chat.media;
const { One, Several, MixedShapes, Interleaved, InlinePath, Unavailable, RemoteImage, Waiting, SentVideo, Simulated } = composeStories(stories);

function tile(name: string): HTMLElement {
  return screen.getByRole("button", { name: copy.open.replace("{name}", name) });
}

function galleries(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-media-gallery]"));
}

describe("chat media stories", () => {
  afterEach(() => act(() => cleanup()));

  it("One draws a lone capture as a tile loading the relay's copy", () => {
    const { container } = render(<One />);
    const image = within(tile("01-sign-in.png")).getByRole("img", { name: "Sign in" });
    expect(image).toHaveAttribute("src", SAMPLE_FILES["/tmp/sim/01-sign-in.png"]);
    expect(galleries(container)).toHaveLength(1);
  });

  it("Several groups images on consecutive lines into one gallery, the text before it a paragraph of its own", () => {
    const { container } = render(<Several />);
    const [gallery] = galleries(container);
    expect(galleries(container)).toHaveLength(1);
    expect(within(gallery).getAllByRole("button")).toHaveLength(4);
    expect(screen.getByText("All four screens of the flow:").tagName).toBe("P");
  });

  it("MixedShapes keeps images a blank line apart in one gallery", () => {
    const { container } = render(<MixedShapes />);
    expect(galleries(container)).toHaveLength(1);
    expect(within(galleries(container)[0]).getAllByRole("button")).toHaveLength(2);
  });

  it("Interleaved splits at text, and the viewer still walks the whole reply", async () => {
    const { container } = render(<Interleaved />);
    expect(galleries(container)).toHaveLength(2);
    await userEvent.click(tile("02-home.png"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 of 2")).toBeInTheDocument();
  });

  it("InlinePath opens the viewer from a path written as code, with the reply's other image", async () => {
    render(<InlinePath />);
    await userEvent.click(screen.getByRole("button", { name: "/tmp/sim/03-settings.png" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("1 of 2")).toBeInTheDocument();
    expect(within(dialog).getByText("03-settings.png")).toBeInTheDocument();
  });

  it("Unavailable turns a file the relay can't serve into a chip naming it", async () => {
    render(<Unavailable />);
    expect(await screen.findByText(copy.unavailable)).toBeInTheDocument();
    expect(tile("gone.png")).toHaveTextContent("gone.png");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("RemoteImage never puts a remote URL in an <img>: it is a link", () => {
    const { container } = render(<RemoteImage />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "build passing" })).toHaveAttribute("href", "https://img.shields.io/badge/build-passing-green");
  });

  it("Waiting holds each tile's place until its picture is fetched", async () => {
    render(<Waiting delayMs={0} />);
    expect(tile("02-home.png").querySelector("[data-slot=skeleton]")).not.toBeNull();
    const image = await within(tile("02-home.png")).findByRole("img", { name: "Home" });
    fireEvent.load(image);
    expect(tile("02-home.png").querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("SentVideo shows a sent video by its extracted frame, badged as a video", () => {
    render(<SentVideo />);
    const video = tile("checkout.mov");
    // Decorative (`alt=""`): the tile's own label names it.
    const frame = video.querySelector("img");
    expect(frame).toHaveAttribute("src", SAMPLE_FILES["/tmp/sim/checkout-frame.jpg"]);
    fireEvent.load(frame!);
    expect(within(video).getByLabelText(copy.video)).toBeInTheDocument();
  });

  it("Simulated steps through every file of the reply, the gone one included, once each", async () => {
    render(<Simulated delayMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: copy.open.replace("{name}", "02-home.png") }));
    const dialog = await screen.findByRole("dialog");
    // Four in the gallery, the chart (mentioned and embedded: once), the gone one.
    expect(within(dialog).getByText("2 of 6")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: copy.viewer.next }));
    expect(within(dialog).getByText("3 of 6")).toBeInTheDocument();
  });
});
