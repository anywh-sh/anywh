import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { en } from "@/i18n/en";
import { LOCALE_STORAGE_KEY } from "@/i18n";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";

/**
 * The relay reports these failures as codes; the wording belongs to the
 * client's dictionary. This tier is where that contract is worth pinning,
 * because the failure it guards against is exactly what shipped before:
 * `setCwd` returned an `FsError` code for four of its five outcomes and a
 * Portuguese sentence for the fifth, through a field typed `string`, and the
 * client interpolated whatever arrived straight into an alert — so a missing
 * folder told the user "not_found".
 *
 * The expected text is read from the dictionary rather than written out
 * again, so this doesn't turn into a second place where the copy lives. The
 * assertion that carries the weight is the negative one: whatever the wording
 * becomes, the raw code must never be what reaches the user.
 */

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

const COMPOSER = en.chat.composer.placeholder;

let relay: FakeRelay;
let alerts: string[];
let originalAlert: typeof window.alert;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  // Pinned rather than inherited from the environment: the provider resolves
  // the initial locale from `navigator.languages`, which differs between a
  // developer's machine and CI, and these assertions read from `en`.
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  alerts = [];
  // Assigned rather than `vi.spyOn`: happy-dom defines `alert` in a way that
  // isn't spy-able, and the app deliberately still uses it here.
  originalAlert = window.alert;
  window.alert = (message?: string) => {
    alerts.push(String(message));
  };
  relay = installFakeRelay("reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
  window.alert = originalAlert;
  vi.restoreAllMocks();
});

async function openConversation(): Promise<void> {
  const user = userEvent.setup({ delay: null });
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByLabelText(COMPOSER);
}

/**
 * Delivered to every open socket, twice each, for two independent reasons.
 *
 * Every socket, because the app opens more than one and the session's isn't
 * reliably the first — addressing `sockets[0]` made these tests pass or fail
 * depending on connection order, which is not what they are meant to prove.
 *
 * Twice, because a new conversation may be applying the profile's default
 * folder, and `ChatPanel` deliberately swallows exactly one `set_cwd_error`
 * while that is in flight (an automatic attempt shouldn't raise an alert
 * nobody asked for). The second emission makes the assertion independent of
 * whether that one-shot suppression happened to be armed.
 */
function emitTwice(payload: unknown): void {
  for (const socket of relay.sockets) {
    socket.emitMessage(payload);
    socket.emitMessage(payload);
  }
}

describe("relay error codes", () => {
  it("renders a sentence for a folder that doesn't exist, never the code", async () => {
    await openConversation();

    emitTwice({ type: "set_cwd_error", code: "not_found" });

    await vi.waitFor(() => expect(alerts.length).toBeGreaterThan(0));
    const message = alerts[alerts.length - 1];
    expect(message).toContain(en.errors.setCwd.not_found);
    expect(message).not.toContain("not_found");
  });

  it("distinguishes a locked folder from a missing one", async () => {
    await openConversation();

    emitTwice({ type: "set_cwd_error", code: "locked" });

    await vi.waitFor(() => expect(alerts.length).toBeGreaterThan(0));
    const message = alerts[alerts.length - 1];
    expect(message).toContain(en.errors.setCwd.locked);
    expect(message).not.toContain(en.errors.setCwd.not_found);
  });

  it("renders an edit failure from its code", async () => {
    await openConversation();

    for (const socket of relay.sockets) socket.emitMessage({ type: "edit_message_error", code: "truncate_failed" });

    await vi.waitFor(() => expect(alerts).toContain(en.errors.editMessage.truncate_failed));
  });
});
