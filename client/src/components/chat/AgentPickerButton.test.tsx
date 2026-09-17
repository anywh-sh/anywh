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
    const { container } = render(<AgentPickerButton profile={profile} agentId="claude" onChange={vi.fn()} />);

    await vi.waitFor(() => expect(getHostInfo).toHaveBeenCalledWith(profile));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when /host-info omits agents (older relay)", () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null });
    const { container } = render(<AgentPickerButton profile={profile} agentId="claude" onChange={vi.fn()} />);

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
    render(<AgentPickerButton profile={profile} agentId="claude" onChange={onChange} />);

    const button = await screen.findByRole("button");
    expect(button).toHaveTextContent(en.chat.composer.agentNames.claude);

    await user.click(button);
    await user.click(await screen.findByRole("menuitem", { name: en.chat.composer.agentNames.codex }));

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
    render(<AgentPickerButton profile={profile} agentId={null} onChange={vi.fn()} />);

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
    render(<AgentPickerButton profile={profile} agentId="some-future-agent" onChange={vi.fn()} />);

    expect(await screen.findByRole("button")).toHaveTextContent("some-future-agent");
  });
});
