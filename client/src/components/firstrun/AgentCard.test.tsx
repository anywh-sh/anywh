import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCard, type AgentCardModel } from "@/components/firstrun/AgentCard";
import { en } from "@/i18n/en";

afterEach(() => {
  cleanup();
});

const copy = en.firstRun.agents;

function card(over: Partial<AgentCardModel>): AgentCardModel {
  return { id: "codex", bin: "codex", state: "ready", version: "0.154.0", loginCommand: "codex login", installUrl: "https://install.example", docsUrl: null, ...over };
}

function renderCard(agent: AgentCardModel) {
  render(
    <ul>
      <AgentCard agent={agent} />
    </ul>,
  );
}

describe("AgentCard", () => {
  it("a ready agent says so with its binary and version, and offers nothing to run", () => {
    renderCard(card({}));
    expect(screen.getByText(copy.state.ready)).toBeInTheDocument();
    expect(screen.getByText(/codex · v0\.154\.0/)).toBeInTheDocument();
    expect(screen.queryByText("codex login")).not.toBeInTheDocument();
  });

  it("a signed-out agent shows the command to copy, never a button that runs it", () => {
    renderCard(card({ state: "noLogin" }));
    expect(screen.getByText(copy.state.noLogin)).toBeInTheDocument();
    expect(screen.getByText(copy.noLoginHint)).toBeInTheDocument();
    expect(screen.getByText("codex login")).toBeInTheDocument();
  });

  it("a missing agent links to its install page, and to the fuller guide when the relay has one", () => {
    renderCard(card({ state: "missing", version: null, docsUrl: "https://docs.example" }));
    expect(screen.getByText(copy.state.missing)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.howToInstall.replace("{agent}", en.chat.composer.agentNames.codex) })).toHaveAttribute("href", "https://install.example");
    expect(screen.getByRole("link", { name: copy.installDocs })).toHaveAttribute("href", "https://docs.example");
  });

  it("without a fuller guide only the install page is linked", () => {
    renderCard(card({ state: "missing", version: null }));
    expect(screen.queryByRole("link", { name: copy.installDocs })).not.toBeInTheDocument();
  });
});
