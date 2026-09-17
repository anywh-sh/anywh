import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentPickerButton } from "./AgentPickerButton";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";

vi.mock("@/lib/relay/filesClient", () => ({
  getHostInfo: vi.fn(),
}));

afterEach(() => cleanup());

const profile: Profile = { id: "p1", label: "Perfil", host: "localhost", relayPort: 4317 };

describe("AgentPickerButton", () => {
  it("renders nothing with zero or one selectable agent (today's only real case)", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null, agents: [{ id: "claude", capabilities: {} }] });
    const { container } = render(<AgentPickerButton profile={profile} />);

    await vi.waitFor(() => expect(getHostInfo).toHaveBeenCalledWith(profile));
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders nothing with more than one selectable agent — no dropdown built yet", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: null,
      agents: [
        { id: "claude", capabilities: {} },
        { id: "codex", capabilities: {} },
      ],
    });
    const { container } = render(<AgentPickerButton profile={profile} />);

    await vi.waitFor(() => expect(getHostInfo).toHaveBeenCalledWith(profile));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when /host-info omits agents (older relay)", () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null });
    const { container } = render(<AgentPickerButton profile={profile} />);

    expect(container).toBeEmptyDOMElement();
  });
});
