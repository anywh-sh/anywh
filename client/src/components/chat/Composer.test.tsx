import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider, LOCALE_STORAGE_KEY, useLocale } from "@/i18n";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import { LARGE_PASTE_MIN_CHARS, LARGE_PASTE_MIN_LINES } from "@/lib/composer/largePaste";
import type { Profile } from "@/lib/profiles/profiles";
import type { ContextUsage, ModelCatalog } from "@/lib/relay/relay-types";

// AgentPickerButton (mounted inside Composer) fetches /host-info — mocked
// here the same way FileTree.test.tsx does, so this suite stays about the
// composer's language switch, not a real network call.
vi.mock("@/lib/relay/filesClient", () => ({
  getHostInfo: vi.fn(),
}));

const profile: Profile = { id: "p1", label: "Perfil", host: "localhost", relayPort: 4317 };

beforeEach(() => {
  vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null });
  localStorage.clear();
  // The provider resolves its first locale from `navigator.languages`, which
  // differs between machines — pinned so the "before" half of the assertion
  // is English wherever this runs.
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => cleanup());

const CLAUDE_CATALOG: ModelCatalog = { options: [{ id: "sonnet", label: "Sonnet 5.5" }], defaultId: "sonnet" };

/** A language switch with no Settings dialog in the way — what's under test
 * is the composer's reaction to it, not the picker that triggers it. */
function Harness({
  agentId = "claude",
  modelCatalog = CLAUDE_CATALOG,
  contextUsage = null,
  onSend = vi.fn(),
  onAddFiles = vi.fn(),
  uploadingImage = false,
}: {
  agentId?: string;
  modelCatalog?: ModelCatalog | null;
  contextUsage?: ContextUsage | null;
  onSend?: (text: string, images: PendingAttachment[]) => void;
  onAddFiles?: (files: FileList | File[]) => void;
  uploadingImage?: boolean;
}) {
  const { setLocale } = useLocale();
  // The app mounts one at the root (`main.tsx`); the held send button needs it.
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setLocale("pt-BR")}>
        switch
      </button>
      <Composer
        profile={profile}
        onSend={onSend}
        turnInFlight={false}
        onStop={vi.fn()}
        pendingImages={[]}
        uploadingImage={uploadingImage}
        onAddFiles={onAddFiles}
        onRemoveImage={vi.fn()}
        agentId={agentId}
        onChangeAgent={vi.fn()}
        permissionMode="default"
        permissionModes={[
          { id: "default", pausesForApproval: true },
          { id: "acceptEdits", pausesForApproval: true },
          { id: "plan", pausesForApproval: true },
          { id: "bypassPermissions", pausesForApproval: false },
        ]}
        onChangePermissionMode={vi.fn()}
        model={null}
        effort={null}
        onChangeEffort={vi.fn()}
        modelCatalog={modelCatalog}
        onChangeModel={vi.fn()}
        modelLocked={false}
        contextUsage={contextUsage}
        onRequestContextBreakdown={vi.fn()}
        compactBoundary={null}
        suggestion={null}
      />
    </TooltipProvider>
  );
}

describe("Composer", () => {
  it("holds the send while an attachment is still uploading, then lets it through", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { rerender } = render(
      <LocaleProvider>
        <Harness onSend={onSend} uploadingImage />
      </LocaleProvider>,
    );

    await user.click(screen.getByLabelText(en.chat.composer.placeholder));
    await user.keyboard("look at this{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    // Held, and saying why: the button names the wait, and the attachments
    // row shows the file on its way.
    expect(screen.getByRole("button", { name: en.chat.composer.sendWaitingForUpload })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(en.chat.composer.attachmentUploading);
    await user.hover(screen.getByRole("button", { name: en.chat.composer.sendWaitingForUpload }).parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(en.chat.composer.sendWaitingForUpload);

    rerender(
      <LocaleProvider>
        <Harness onSend={onSend} uploadingImage={false} />
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: en.common.send })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(en.chat.composer.placeholder));
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("look at this", []);
  });

  it("pastes text with its spacing intact, even when the clipboard also offers HTML", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <LocaleProvider>
        <Harness onSend={onSend} />
      </LocaleProvider>,
    );

    await user.click(screen.getByLabelText(en.chat.composer.placeholder));
    const clipboard = new DataTransfer();
    // The HTML a browser would offer for the same copy, whose parse collapses
    // the indentation and turns each line into a paragraph.
    clipboard.setData("text/html", "<div>if (x) {</div><div>&nbsp;&nbsp;run();</div><div></div><div>}</div>");
    clipboard.setData("text/plain", "  if (x) {\r\n    run();\n\n\n}\n");
    await user.paste(clipboard);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("  if (x) {\n    run();\n\n\n}", []);
  });

  it("turns a large paste into a \"pasted text.txt\" attachment instead of inline text", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onAddFiles = vi.fn();
    render(
      <LocaleProvider>
        <Harness onSend={onSend} onAddFiles={onAddFiles} />
      </LocaleProvider>,
    );

    await user.click(screen.getByLabelText(en.chat.composer.placeholder));
    const big = Array.from({ length: LARGE_PASTE_MIN_LINES }, (_, i) => `- step ${String(i + 1)}`).join("\n");
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", big);
    await user.paste(clipboard);

    expect(onAddFiles).toHaveBeenCalledOnce();
    const [files] = onAddFiles.mock.calls[0] as [File[]];
    expect(files.map((file) => file.name)).toEqual([en.chat.composer.pastedTextFileName]);
    expect(await files[0].text()).toBe(big);
    // Nothing landed in the field: sending now is an empty message.
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps a paste just under the bounds inline", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onAddFiles = vi.fn();
    render(
      <LocaleProvider>
        <Harness onSend={onSend} onAddFiles={onAddFiles} />
      </LocaleProvider>,
    );

    await user.click(screen.getByLabelText(en.chat.composer.placeholder));
    const small = "a b ".repeat(Math.floor((LARGE_PASTE_MIN_CHARS - 1) / 4));
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", small);
    await user.paste(clipboard);
    await user.keyboard("{Enter}");

    expect(onAddFiles).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(small.trim(), []);
  });

  it("still links a URL inside pasted text", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <LocaleProvider>
        <Harness onSend={onSend} />
      </LocaleProvider>,
    );

    await user.click(screen.getByLabelText(en.chat.composer.placeholder));
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "see https://example.com/a now\nok");
    await user.paste(clipboard);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("see [https://example.com/a](https://example.com/a) now\nok", []);
  });

  it("follows a language switch even though the editor is never recreated", async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );

    expect(screen.getByLabelText(en.chat.composer.placeholder)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.common.send })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "switch" }));

    // Tiptap builds the editor once, and both of these were captured at that
    // moment — without the effect that refreshes them, the field would keep
    // announcing itself in the language the app started in.
    expect(screen.getByLabelText(ptBr.chat.composer.placeholder)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ptBr.common.send })).toBeInTheDocument();
  });

  it("redraws the placeholder decoration, which only a transaction recomputes", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole("button", { name: "switch" }));

    const paragraph = container.querySelector(".ProseMirror p");
    expect(paragraph).toHaveAttribute("data-placeholder", ptBr.chat.composer.placeholderTask);
  });

  // The picker used to be gated on `agentId === "claude"` — the catalog is
  // now what decides, whichever agent it belongs to.
  it("offers the model picker for any agent whose catalog is known, and hides it when there is none", () => {
    const codexCatalog: ModelCatalog = { options: [{ id: "gpt-5.5", label: "GPT-5.5" }], defaultId: "gpt-5.5" };
    const { rerender } = render(
      <LocaleProvider>
        <Harness agentId="codex" modelCatalog={codexCatalog} />
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: /GPT-5.5/ })).toBeInTheDocument();

    rerender(
      <LocaleProvider>
        <Harness agentId="codex" modelCatalog={null} />
      </LocaleProvider>,
    );
    expect(screen.queryByRole("button", { name: /GPT-5.5/ })).not.toBeInTheDocument();
  });

  it("shows the context chip as a ring only, and send as an arrow-only button", () => {
    render(
      <LocaleProvider>
        <Harness contextUsage={{ model: "claude-opus-5", contextWindowSize: 200_000, usedTokens: 128_000 }} />
      </LocaleProvider>,
    );

    const chip = screen.getByRole("button", { name: en.chat.composer.context.ariaLabel.replace("{percent}", "64") });
    expect(chip.textContent).not.toContain("k/");
    expect(screen.getByRole("button", { name: en.common.send })).toHaveTextContent("");
  });
});
