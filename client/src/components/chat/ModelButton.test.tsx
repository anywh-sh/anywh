import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelButton } from "./ModelButton";
import { en } from "@/i18n/en";
import type { ModelCatalog } from "@/lib/relay/relay-types";

afterEach(() => cleanup());

// Shapes as the relay sends them: Claude's from its CLI's own `/model`
// picker, Codex's from `model/list` — both verbatim display names.
const CLAUDE: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks" },
    { id: "sonnet", label: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
  ],
  defaultId: "opus",
};

const CODEX: ModelCatalog = {
  options: [
    { id: "gpt-6-astra", label: "GPT-6-Astra" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ],
  defaultId: "gpt-6-astra",
};

describe("ModelButton", () => {
  it("names the model the session runs by the CLI's own label, the catalog's default until one is picked", () => {
    render(<ModelButton model={null} catalog={CLAUDE} onChange={vi.fn()} disabled={false} locked={false} />);

    expect(screen.getByRole("button")).toHaveTextContent("Opus 5.5");
  });

  it("stays pending (and shut) until the agent's catalog is known", () => {
    render(<ModelButton model={null} catalog={null} onChange={vi.fn()} disabled={false} locked={false} />);

    expect(screen.getByRole("button")).toHaveTextContent(en.chat.composer.pending);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("lists each model once, by its own name alone, with the CLI's blurb only as a tooltip", async () => {
    const user = userEvent.setup();
    render(<ModelButton model={null} catalog={CLAUDE} onChange={vi.fn()} disabled={false} locked={false} />);

    await user.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Opus 5.5", "Sonnet 5.5", "Opus 4.8"]);
    expect(items[0]).toHaveAttribute("title", "For complex work and everyday tasks");
  });

  it("works the same for any agent — nothing in it knows which one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelButton model="gpt-5.5" catalog={CODEX} onChange={onChange} disabled={false} locked={false} />);

    expect(screen.getByRole("button")).toHaveTextContent("GPT-5.5");
    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: "GPT-6-Astra" }));

    expect(onChange).toHaveBeenCalledWith("gpt-6-astra");
  });

  it("falls back to the raw id for a pick the catalog doesn't list, rather than inventing a name", () => {
    render(<ModelButton model="claude-opus-3" catalog={CLAUDE} onChange={vi.fn()} disabled={false} locked={false} />);

    expect(screen.getByRole("button")).toHaveTextContent("claude-opus-3");
  });

  it("says why a locked model can't be changed instead of just greying out", () => {
    render(<ModelButton model="opus" catalog={CLAUDE} onChange={vi.fn()} disabled={false} locked />);

    expect(screen.getByRole("button")).toHaveAttribute("title", en.chat.composer.modelLocked);
  });

  it("keeps the menu shut while locked, whichever event the webview fires", async () => {
    // `pointerEventsCheck: 0` because the point is the state guard, not the
    // `pointer-events: none` a disabled button already gets for free.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<ModelButton model="opus" catalog={CLAUDE} onChange={onChange} disabled={false} locked />);

    // The open is blocked in state, because Radix's Trigger reads its own
    // `disabled` prop and at least one WebView opened the menu anyway from a
    // `<button disabled>`.
    await user.click(screen.getByRole("button"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
