import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same mocks as sendMessage.test.tsx — see the comment there for why these
// two are unavoidable outside a real Tauri shell.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("fake relay reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

/** Types `text` into a fresh conversation's composer and waits for the send
 * button to become enabled — the same two gates (non-empty composer, fake
 * relay's `open`+`caught_up` landed) `sendMessage.test.tsx` waits on, needed
 * here too since Enter's own send path (`Composer`'s `handleKeyDown`) is
 * gated behind that same "connected" flag. Returns the composer without
 * pressing Enter — callers decide how the text is (or isn't) submitted. */
async function typeIntoComposer(user: ReturnType<typeof userEvent.setup>, text: string) {
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  const composer = await screen.findByLabelText(en.chat.composer.placeholder);
  await user.type(composer, text);
  const sendButton = await screen.findByRole("button", { name: en.common.send });
  await vi.waitFor(() => expect(sendButton).toBeEnabled());
  return composer;
}

/** The banner's question with the suggested command spliced into the middle,
 * so the assertion reads the dictionary rather than one language's wording.
 * Matching on the leading half is enough — Testing Library compares a node's
 * own text, and the command itself sits in a child `<span>` of its own. */
const TYPO_QUESTION = en.chat.composer.typo.question.split("{command}")[0].trim();

describe("typo'd slash command", () => {
  it("blocks the send and offers the fix instead of forwarding it as a chat message", async () => {
    const user = userEvent.setup();
    const composer = await typeIntoComposer(user, "/cler");

    await user.type(composer, "{Enter}");

    expect(await screen.findByText(TYPO_QUESTION, { exact: false })).toBeInTheDocument();
    expect(screen.getByText("/clear")).toBeInTheDocument();
    // Blocked: the text stays put in the composer (not cleared like a real
    // send would), and never became a chat message — no reply came back.
    expect(composer).toHaveTextContent("/cler");
    expect(screen.queryByText("fake relay reply")).not.toBeInTheDocument();
  });

  it("applies the suggested fix on demand instead of sending right away", async () => {
    const user = userEvent.setup();
    const composer = await typeIntoComposer(user, "/moel opus");

    await user.type(composer, "{Enter}");
    await user.click(await screen.findByRole("button", { name: en.chat.composer.typo.use }));

    expect(composer).toHaveTextContent("/model opus");
    // Applying the fix only fills the composer — it's still up to the user
    // to send it, same as picking an entry from the autocomplete menu.
    expect(screen.queryByText(TYPO_QUESTION, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText("fake relay reply")).not.toBeInTheDocument();
  });

  it("sends the original text as-is when the user confirms it wasn't a typo", async () => {
    const user = userEvent.setup();
    const composer = await typeIntoComposer(user, "/cler");

    await user.type(composer, "{Enter}");
    await user.click(await screen.findByRole("button", { name: en.chat.composer.typo.sendAnyway }));

    expect(await screen.findByText("/cler")).toBeInTheDocument();
    expect(await screen.findByText("fake relay reply")).toBeInTheDocument();
  });
});
