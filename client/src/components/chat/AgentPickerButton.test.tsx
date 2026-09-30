import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPickerButton } from "./AgentPickerButton";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";
import { en } from "@/i18n/en";

vi.mock("@/lib/relay/filesClient", () => ({
  getHostInfo: vi.fn(),
}));

afterEach(() => cleanup());

const profile: Profile = { id: "p1", label: "Perfil", host: "localhost", relayPort: 4317 };

describe("AgentPickerButton", () => {
  it("renders nothing with zero or one selectable agent", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null, agents: [{ id: "claude", capabilities: {} }] });
    const { container } = render(<AgentPickerButton profile={profile} agentId="claude" onChange={vi.fn()} locked={false} />);

    await vi.waitFor(() => expect(getHostInfo).toHaveBeenCalledWith(profile));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when /host-info omits agents (older relay)", () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null });
    const { container } = render(<AgentPickerButton profile={profile} agentId="claude" onChange={vi.fn()} locked={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a real dropdown once two or more agents are selectable, and dispatches onChange", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: null,
      agents: [
        { id: "claude", capabilities: {} },
        { id: "codex", capabilities: {} },
      ],
    });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AgentPickerButton profile={profile} agentId="claude" onChange={onChange} locked={false} />);

    const button = await screen.findByRole("button", { name: en.chat.composer.agentNames.claude });
    expect(button.querySelector("svg")).not.toBeNull();

    await user.click(button);
    await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${en.chat.composer.agentNames.codex}`) }));

    expect(onChange).toHaveBeenCalledWith("codex");
  });

  it("is disabled until the first agent_state arrives (agentId null)", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: null,
      agents: [
        { id: "claude", capabilities: {} },
        { id: "codex", capabilities: {} },
      ],
    });
    render(<AgentPickerButton profile={profile} agentId={null} onChange={vi.fn()} locked={false} />);

    expect(await screen.findByRole("button")).toBeDisabled();
  });

  it("an agent id this build has no name for renders as the raw id, instead of crashing", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: null,
      agents: [
        { id: "claude", capabilities: {} },
        { id: "some-future-agent", capabilities: {} },
      ],
    });
    render(<AgentPickerButton profile={profile} agentId="some-future-agent" onChange={vi.fn()} locked={false} />);

    expect(await screen.findByRole("button", { name: "some-future-agent" })).toBeInTheDocument();
  });

  it("shows vendor and CLI version under each name, omitting the line when neither exists", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: null,
      agents: [
        { id: "claude", capabilities: {}, version: "2.1.3" },
        { id: "some-future-agent", capabilities: {} },
      ],
    });
    const user = userEvent.setup();
    render(<AgentPickerButton profile={profile} agentId="claude" onChange={vi.fn()} locked={false} />);

    await user.click(await screen.findByRole("button"));

    expect(await screen.findByText("Anthropic · claude v2.1.3")).toBeInTheDocument();
    const unknown = screen.getByRole("menuitem", { name: "some-future-agent" });
    expect(unknown).toHaveTextContent(/^some-future-agent$/);
  });

  it("locked: no chevron, the menu does not open, and the tooltip still names the agent", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: null,
      agents: [
        { id: "claude", capabilities: {} },
        { id: "codex", capabilities: {} },
      ],
    });
    const user = userEvent.setup();
    render(<AgentPickerButton profile={profile} agentId="claude" onChange={vi.fn()} locked />);

    const button = await screen.findByRole("button", { name: en.chat.composer.agentNames.claude });
    expect(button).toHaveAttribute("title", en.chat.composer.agentNames.claude);
    expect(button).not.toHaveTextContent("▾");
    await user.click(button);

    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });
});
