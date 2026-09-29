import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelButton } from "./ModelButton";
import { recordAvailableModels } from "@/lib/composer/modelCatalog";
import { en } from "@/i18n/en";

afterEach(() => cleanup());

describe("ModelButton", () => {
  it("falls back to the profile's own default model until the session picks one", () => {
    render(<ModelButton model={null} defaultModel="Sonnet" onChange={vi.fn()} disabled={false} locked={false} />);

    expect(screen.getByRole("button")).toHaveTextContent("Sonnet");
  });

  it("says why a locked model can't be changed instead of just greying out", () => {
    render(<ModelButton model="opus" defaultModel="Sonnet" onChange={vi.fn()} disabled={false} locked />);

    expect(screen.getByRole("button")).toHaveAttribute("title", en.chat.composer.modelLocked);
  });

  it("keeps the menu shut while locked, whichever event the webview fires", async () => {
    // `pointerEventsCheck: 0` because the point is the state guard, not the
    // `pointer-events: none` a disabled button already gets for free.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<ModelButton model="opus" defaultModel="Sonnet" onChange={onChange} disabled={false} locked />);

    // The open is blocked in state, because Radix's Trigger reads its own
    // `disabled` prop and at least one WebView opened the menu anyway from a
    // `<button disabled>`.
    await user.click(screen.getByRole("button"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("switches the model from the menu while the conversation is still fresh", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelButton model="sonnet" defaultModel="Sonnet" onChange={onChange} disabled={false} locked={false} />);

    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: "Opus" }));

    expect(onChange).toHaveBeenCalledWith("opus");
  });

  it("shows the version each alias resolves to, once the relay has reported it", async () => {
    // Shapes are the relay's `default_model_state.resolved`, verbatim from
    // the real CLI's `/model` probe under `--model <alias>`.
    recordAvailableModels(["sonnet", "opus", "opus[1m]", "haiku"], {
      sonnet: "Sonnet 5.5",
      opus: "Opus 5.5",
      "opus[1m]": "Opus 5.5 (1M context)",
      haiku: "Haiku 4.5",
    });
    const user = userEvent.setup();
    render(<ModelButton model="opus" defaultModel="Sonnet 5.5" onChange={vi.fn()} disabled={false} locked={false} />);

    expect(screen.getByRole("button")).toHaveTextContent("Opus 5.5");

    await user.click(screen.getByRole("button"));
    expect(
      await screen.findByRole("menuitem", {
        name: /Opus \(1M\).*Opus 5\.5 \(1M context\)/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Haiku.*Haiku 4\.5/ })).toBeInTheDocument();
  });
});
