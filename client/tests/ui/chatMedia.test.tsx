import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same two Tauri seams as sendMessage.test.tsx, for the same reasons.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

// An agent's reply that shows two simulator captures, the way the relay asks
// agents to: Markdown images with absolute paths.
const REPLY = "Here are the two screens:\n![Sign in](/tmp/sim/sign-in.png)\n![Home](/tmp/sim/home.png)";

let relay: FakeRelay;

afterEach(() => {
  cleanup();
  relay.uninstall();
  vi.restoreAllMocks();
});

async function sendAndAwaitReply(): Promise<void> {
  const user = userEvent.setup();
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  const composer = await screen.findByLabelText(en.chat.composer.placeholder);
  await user.click(composer);
  await user.keyboard("show me the screens{Enter}");
  await screen.findByText("Here are the two screens:");
}

describe("media in an agent's reply", () => {
  beforeEach(() => {
    localStorage.clear();
    seedShellProfile();
  });

  it("draws the reply's images as tiles from the relay's /files/media and opens the viewer on them", async () => {
    relay = installFakeRelay(REPLY);
    await sendAndAwaitReply();

    const signIn = await screen.findByRole("button", { name: en.chat.media.open.replace("{name}", "sign-in.png") });
    const src = new URL(within(signIn).getByRole("img", { name: "Sign in" }).getAttribute("src")!);
    expect(src.pathname).toBe("/files/media");
    expect(src.searchParams.get("path")).toBe("/tmp/sim/sign-in.png");

    await userEvent.click(screen.getByRole("button", { name: en.chat.media.open.replace("{name}", "home.png") }));
    const viewer = await screen.findByRole("dialog");
    expect(within(viewer).getByText("2 of 2")).toBeInTheDocument();
    expect(within(viewer).getByText("Home")).toBeInTheDocument();
  });

  it("keeps an image as its caption on a relay that can't serve media yet", async () => {
    // A relay that answers /host-info without `chat_media` in its features.
    relay = installFakeRelay(REPLY, { control: { agents: [{ id: "claude", installed: true }] } });
    await sendAndAwaitReply();

    await vi.waitFor(() => expect(screen.getByText("Sign in")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: en.chat.media.open.replace("{name}", "sign-in.png") })).not.toBeInTheDocument();
    expect(document.querySelector('img[src*="/files/media"]')).toBeNull();
  });
});

describe("media a reply only names", () => {
  beforeEach(() => {
    localStorage.clear();
    seedShellProfile();
  });

  it("previews the files under the finished reply, from the relay's /files/media", async () => {
    relay = installFakeRelay("Here are the two screens:\n\n- `/tmp/sim/sign-in.png`\n- `/tmp/sim/home.png`");
    await sendAndAwaitReply();

    const signIn = await screen.findByRole("button", { name: en.chat.media.open.replace("{name}", "sign-in.png") });
    const image = signIn.querySelector("img");
    expect(new URL(image!.getAttribute("src")!).searchParams.get("path")).toBe("/tmp/sim/sign-in.png");
    expect(screen.getByRole("button", { name: en.chat.media.open.replace("{name}", "home.png") })).toBeInTheDocument();
  });
});

