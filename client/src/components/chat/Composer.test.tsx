import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { LocaleProvider, LOCALE_STORAGE_KEY, useLocale } from "@/i18n";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import { getHostInfo } from "@/lib/relay/filesClient";
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
}: {
  agentId?: string;
  modelCatalog?: ModelCatalog | null;
  contextUsage?: ContextUsage | null;
}) {
  const { setLocale } = useLocale();
  return (
    <>
      <button type="button" onClick={() => setLocale("pt-BR")}>
        switch
      </button>
      <Composer
        profile={profile}
        onSend={vi.fn()}
        turnInFlight={false}
        onStop={vi.fn()}
        pendingImages={[]}
        uploadingImage={false}
        onAddFiles={vi.fn()}
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
    </>
  );
}

describe("Composer", () => {
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
    expect(paragraph).toHaveAttribute("data-placeholder", ptBr.chat.composer.placeholder);
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
    expect(screen.getByRole("button", { name: "GPT-5.5" })).toBeInTheDocument();

    rerender(
      <LocaleProvider>
        <Harness agentId="codex" modelCatalog={null} />
      </LocaleProvider>,
    );
    expect(screen.queryByRole("button", { name: "GPT-5.5" })).not.toBeInTheDocument();
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
