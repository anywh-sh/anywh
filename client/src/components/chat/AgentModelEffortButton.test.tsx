import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentModelEffortButton } from "./AgentModelEffortButton";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";
import type { ModelCatalog } from "@/lib/relay/relayClient";
import { en } from "@/i18n/en";

vi.mock("@/lib/relay/filesClient", () => ({
  getHostInfo: vi.fn(),
}));

afterEach(() => cleanup());

const profile: Profile = { id: "p1", label: "Perfil", host: "localhost", relayPort: 4317 };
const TWO_AGENTS = {
  hostname: "host",
  platform: "linux",
  editor: null,
  agents: [
    { id: "claude", capabilities: {} },
    { id: "codex", capabilities: {} },
  ],
};
const CATALOG: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 5.5", efforts: [{ id: "low" }, { id: "high" }] },
    { id: "haiku", label: "Haiku 4.5" },
  ],
  defaultId: "opus",
};

function renderButton(overrides: Partial<React.ComponentProps<typeof AgentModelEffortButton>> = {}) {
  const props = {
    profile,
    agentId: "claude",
    onChangeAgent: vi.fn(),
    model: null,
    catalog: CATALOG,
    onChangeModel: vi.fn(),
    effort: null,
    onChangeEffort: vi.fn(),
    disabled: false,
    locked: false,
    ...overrides,
  };
  render(<AgentModelEffortButton {...props} />);
  return props;
}

describe("AgentModelEffortButton", () => {
  it("renders nothing without a catalog and with a single agent", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null, agents: [{ id: "claude", capabilities: {} }] });
    const { container } = render(
      <AgentModelEffortButton profile={profile} agentId="claude" onChangeAgent={vi.fn()} model={null} catalog={null} onChangeModel={vi.fn()} effort={null} onChangeEffort={vi.fn()} disabled={false} locked={false} />,
    );
    await vi.waitFor(() => expect(getHostInfo).toHaveBeenCalledWith(profile));
    expect(container).toBeEmptyDOMElement();
  });

  it("reads the agent tile, the model and the effort in one trigger", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    renderButton({ effort: "high" });
    const trigger = await screen.findByRole("button");
    expect(trigger).toHaveTextContent("CC");
    expect(trigger).toHaveTextContent("Opus 5.5");
    expect(trigger).toHaveTextContent("high");
  });

  it("one menu carries the three choices", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton();
    await user.click(await screen.findByRole("button"));

    await user.click(await screen.findByRole("menuitem", { name: new RegExp(en.chat.composer.agentNames.codex) }));
    expect(props.onChangeAgent).toHaveBeenCalledWith("codex");

    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: "Haiku 4.5" }));
    expect(props.onChangeModel).toHaveBeenCalledWith("haiku");

    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: "High" }));
    expect(props.onChangeEffort).toHaveBeenCalledWith("high");

    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: en.chat.composer.effortDefault }));
    expect(props.onChangeEffort).toHaveBeenLastCalledWith(null);
  });

  it("a model with no efforts has no effort section", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    renderButton({ model: "haiku" });
    await user.click(await screen.findByRole("button"));
    await screen.findByRole("menuitem", { name: "Haiku 4.5" });
    expect(screen.queryByText(en.chat.composer.menu.effort)).not.toBeInTheDocument();
  });

  it("locked: the model is fixed and another agent can't be picked", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    renderButton({ locked: true });
    await user.click(await screen.findByRole("button"));

    expect(await screen.findByRole("menuitem", { name: new RegExp(en.chat.composer.agentNames.codex) })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Haiku 4.5" })).not.toBeInTheDocument();
    expect(screen.getByText(en.chat.composer.menu.fixedInSession)).toBeInTheDocument();
  });

  it("is disabled until the first agent_state arrives", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    renderButton({ agentId: null, disabled: true });
    expect(await screen.findByRole("button")).toBeDisabled();
  });

  it("an agent id this build has no name for renders as the raw id, instead of crashing", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ ...TWO_AGENTS, agents: [{ id: "claude", capabilities: {} }, { id: "some-future-agent", capabilities: {} }] });
    renderButton({ agentId: "some-future-agent" });
    expect(await screen.findByRole("button")).toHaveAttribute("title", expect.stringContaining("some-future-agent"));
  });
});
