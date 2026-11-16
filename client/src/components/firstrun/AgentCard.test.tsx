import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCard, type AgentCardModel } from "@/components/firstrun/AgentCard";
import { en } from "@/i18n/en";

afterEach(() => {
  cleanup();
});

const copy = en.firstRun.agents;

function card(over: Partial<AgentCardModel>): AgentCardModel {
  return { id: "codex", bin: "codex", state: "ready", version: "0.154.0", signIn: true, installUrl: "https://install.example", docsUrl: null, ...over };
}

function renderCard(agent: AgentCardModel, onSignIn?: () => void) {
  render(
    <ul>
      <AgentCard agent={agent} onSignIn={onSignIn} />
    </ul>,
  );
}

describe("AgentCard", () => {
  it("a ready agent says so with its binary and version, and offers nothing to run", () => {
    renderCard(card({}));
    expect(screen.getByText(copy.state.ready)).toBeInTheDocument();
    expect(screen.getByText(/codex · v0\.154\.0/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("a signed-out agent offers to sign in from the card, and never prints a command", async () => {
    const onSignIn = vi.fn();
    renderCard(card({ state: "noLogin" }), onSignIn);
    expect(screen.getByText(copy.state.noLogin)).toBeInTheDocument();
    expect(screen.getByText(copy.noLoginHint)).toBeInTheDocument();
    expect(screen.queryByText("codex login")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: copy.connect.replace("{agent}", en.chat.composer.agentNames.codex) }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("an agent the relay can't sign in offers no button", () => {
    renderCard(card({ state: "noLogin", signIn: false }), () => {});
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("a missing agent links to its install page, and to the fuller guide when the relay has one", () => {
    renderCard(card({ state: "missing", version: null, docsUrl: "https://docs.example" }));
    expect(screen.getByText(copy.state.missing)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.howToInstall.replace("{agent}", en.chat.composer.agentNames.codex) })).toHaveAttribute("href", "https://install.example");
    expect(screen.getByRole("link", { name: copy.installDocs })).toHaveAttribute("href", "https://docs.example");
  });

  it("as a choice, the radio is named by the agent and described by what was found and its state", () => {
    render(
      <ul>
        <AgentCard agent={card({ state: "noLogin" })} choice={{ name: "agents", checked: false, onSelect: () => {} }} />
      </ul>,
    );
    const radio = screen.getByRole("radio", { name: en.chat.composer.agentNames.codex });
    expect(radio).toHaveAccessibleDescription(new RegExp(copy.state.noLogin));
    expect(radio).toHaveAccessibleDescription(/codex · v0\.154\.0/);
  });

  it("without a fuller guide only the install page is linked", () => {
    renderCard(card({ state: "missing", version: null }));
    expect(screen.queryByRole("link", { name: copy.installDocs })).not.toBeInTheDocument();
  });
});
