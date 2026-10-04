import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffortButton } from "./EffortButton";
import { en } from "@/i18n/en";
import type { ModelCatalog } from "@/lib/relay/relay-types";

afterEach(() => cleanup());

// Shapes as the relay sends them. Claude 2.1.289 lists levels per model and
// no default; codex-cli 0.154.0 lists both, with `ultra` on one model only.
const CLAUDE: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 5.5", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] },
    { id: "haiku", label: "Haiku 4.5" },
  ],
  defaultId: "opus",
};

const CODEX: ModelCatalog = {
  options: [
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      defaultEffort: "medium",
      efforts: [{ id: "low", description: "Fast responses with lighter reasoning" }, { id: "medium" }, { id: "ultra" }],
    },
    { id: "gpt-5.5", label: "GPT-5.5", defaultEffort: "medium", efforts: [{ id: "low" }, { id: "medium" }] },
  ],
  defaultId: "gpt-5.6-terra",
};

function renderButton(props: Partial<Parameters<typeof EffortButton>[0]> & { catalog: ModelCatalog | null }) {
  return render(<EffortButton effort={null} model={null} onChange={vi.fn()} disabled={false} {...props} />);
}

describe("EffortButton", () => {
  it("is hidden when the effective model lists no efforts, or the catalog isn't known", () => {
    renderButton({ catalog: CLAUDE, model: "haiku" });
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    renderButton({ catalog: null });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("preselects the model's own default effort when the CLI reports one", () => {
    renderButton({ catalog: CODEX });
    expect(screen.getByRole("button")).toHaveTextContent(en.chat.composer.effortLabels.medium);
  });

  it("shows an explicit pick over the default, and the raw id for a level it has no label for", () => {
    renderButton({ catalog: CODEX, effort: "low" });
    expect(screen.getByRole("button")).toHaveTextContent("Low");
    cleanup();
    renderButton({ catalog: { options: [{ id: "m", label: "M", efforts: [{ id: "turbo" }] }] }, model: "m", effort: "turbo" });
    expect(screen.getByRole("button")).toHaveTextContent("turbo");
  });

  it("offers a Default item only when the CLI reports no default effort (Claude), and it clears the pick", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderButton({ catalog: CLAUDE, effort: "high", onChange });

    await user.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
    await user.click(items[0]);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("has no Default item for a model that reports a default, lists only that model's levels, and shows the CLI's blurb as a tooltip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderButton({ catalog: CODEX, onChange });

    await user.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Low", "Medium", "Ultra"]);
    expect(items[0]).toHaveAttribute("title", "Fast responses with lighter reasoning");
    await user.click(items[2]);
    expect(onChange).toHaveBeenCalledWith("ultra");
  });

  it("follows the effective model: gpt-5.5 has no ultra", async () => {
    const user = userEvent.setup();
    renderButton({ catalog: CODEX, model: "gpt-5.5" });
    await user.click(screen.getByRole("button"));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Low", "Medium"]);
  });

  it("is never locked — only disabled while the connection isn't ready", () => {
    renderButton({ catalog: CODEX });
    expect(screen.getByRole("button")).toBeEnabled();
    cleanup();
    renderButton({ catalog: CODEX, disabled: true });
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
