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
// Shaped like the real probes: Claude's aliases plus pinned exact versions
// and no default effort; Codex's with a default effort of its own.
const CATALOG: ModelCatalog = {
  options: [
    { id: "opus", label: "Opus 5.5", efforts: [{ id: "low" }, { id: "high" }] },
    { id: "sonnet", label: "Sonnet 5.5", efforts: [{ id: "low" }, { id: "high" }] },
    { id: "haiku", label: "Haiku 5.5" },
    { id: "claude-opus-4-8", label: "Opus 4.8", pinnedVersion: true, efforts: [{ id: "low" }] },
  ],
  defaultId: "opus",
};
const CODEX_CATALOG: ModelCatalog = {
  options: [{ id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }], defaultEffort: "medium" }],
  defaultId: "gpt-5.6-terra",
};
const copy = en.chat.composer;

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
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger).toHaveTextContent("Opus 5.5");
    expect(trigger).toHaveTextContent("high");
  });

  it("the top level lists the current line-up with its digits; pinned versions sit under More models", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton();
    await user.click(await screen.findByRole("button"));

    expect(await screen.findByText(copy.menu.modelHeader)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sonnet 5.5 2" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Opus 4\.8/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: copy.menu.moreModels }));
    await user.click(await screen.findByRole("menuitem", { name: /Opus 4\.8/ }));
    expect(props.onChangeModel).toHaveBeenCalledWith("claude-opus-4-8");
  });

  it("picking the model the session is already on sends nothing", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton();
    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: "Opus 5.5" }));
    expect(props.onChangeModel).not.toHaveBeenCalled();
  });

  it("a digit picks that top-level model and closes the menu", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton();
    await user.click(await screen.findByRole("button"));
    await screen.findByRole("menu");
    await user.keyboard("3");
    expect(props.onChangeModel).toHaveBeenCalledWith("haiku");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a session on a pinned version names it on the More models row", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    renderButton({ model: "claude-opus-4-8" });
    await user.click(await screen.findByRole("button"));
    expect(await screen.findByRole("menuitem", { name: `${copy.menu.moreModels} Opus 4.8` })).toBeInTheDocument();
  });

  it("effort is a submenu: a level, or Default when the CLI has none of its own", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton();
    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: `${copy.menu.effort} ${copy.effortDefault}` }));
    expect(await screen.findByText(copy.menu.effortHint)).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "High" }));
    expect(props.onChangeEffort).toHaveBeenCalledWith("high");

    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${copy.menu.effort}`) }));
    await user.click(await screen.findByRole("menuitem", { name: copy.effortDefault }));
    expect(props.onChangeEffort).toHaveBeenLastCalledWith(null);
  });

  it("an agent with a default effort of its own badges it instead of offering Default", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    renderButton({ agentId: "codex", catalog: CODEX_CATALOG });
    await user.click(await screen.findByRole("button"));
    expect(screen.queryByRole("menuitem", { name: copy.menu.moreModels })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: `${copy.menu.effort} Medium` }));
    expect(await screen.findByRole("menuitem", { name: `Medium ${copy.effortDefault}` })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: copy.effortDefault })).not.toBeInTheDocument();
  });

  it("the agent is a submenu of the relay's other runtimes", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton();
    await user.click(await screen.findByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${copy.menu.agent}`) }));
    await user.click(await screen.findByRole("menuitem", { name: new RegExp(copy.agentNames.codex) }));
    expect(props.onChangeAgent).toHaveBeenCalledWith("codex");
  });

  it("a model with no efforts has no effort row", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    renderButton({ model: "haiku" });
    await user.click(await screen.findByRole("button"));
    await screen.findByRole("menuitem", { name: /Haiku 5\.5/ });
    expect(screen.queryByRole("menuitem", { name: new RegExp(`^${copy.menu.effort}`) })).not.toBeInTheDocument();
  });

  it("locked: model and agent are fixed, effort still changes", async () => {
    vi.mocked(getHostInfo).mockResolvedValue(TWO_AGENTS);
    const user = userEvent.setup();
    const props = renderButton({ locked: true });
    await user.click(await screen.findByRole("button"));

    expect(await screen.findByRole("menuitem", { name: new RegExp(`^${copy.menu.agent}`) })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: /Sonnet/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: copy.menu.moreModels })).not.toBeInTheDocument();
    expect(screen.getByText(copy.menu.fixedInSession)).toBeInTheDocument();

    await user.keyboard("2");
    expect(props.onChangeModel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("menuitem", { name: new RegExp(`^${copy.menu.effort}`) }));
    await user.click(await screen.findByRole("menuitem", { name: "Low" }));
    expect(props.onChangeEffort).toHaveBeenCalledWith("low");
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
