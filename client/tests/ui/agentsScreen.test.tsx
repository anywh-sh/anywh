import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsScreen } from "@/components/firstrun/AgentsScreen";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/i18n";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import { getPendingAgentsProfileId } from "@/lib/install/pendingAgents";
import { __resetFirstRunForTests, beginFirstRun, getFirstRunSnapshot } from "@/lib/profiles/firstRun";
import { findProfile, setProfiles, type Profile } from "@/lib/profiles/profiles";
import { installFakeRelay, type FakeAgent, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";

/**
 * The "Your agents" screen against a relay that answers `/control/agents`
 * (the fake relay's scripted control routes). The screen is mounted on its
 * own — the first-run router that leads to it is not part of this tier's
 * subject — and the hand-over into the shell is checked by what "Start"
 * leaves behind: the gate state, the saved profile, the relay's PATCH and,
 * through the real `App`, the agent a new session switches to.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const copy = en.firstRun.agents;
const profile: Profile = {
  id: "default",
  label: "Personal",
  host: "127.0.0.1",
  relayPort: 8765,
};

const CLAUDE: FakeAgent = {
  id: "claude",
  installed: true,
  version: "2.1.3",
  loggedIn: true,
  loginCommand: "claude auth login",
  installUrl: "https://claude.example/setup",
};
const CODEX_NO_LOGIN: FakeAgent = {
  id: "codex",
  installed: true,
  version: "0.154.0",
  loggedIn: false,
  loginCommand: "codex login",
  installUrl: "https://codex.example/cli",
};
const CODEX_MISSING: FakeAgent = {
  id: "codex",
  installed: false,
  version: null,
  loggedIn: null,
  loginCommand: "codex login",
  installUrl: "https://codex.example/cli",
};
const CLAUDE_MISSING: FakeAgent = {
  ...CLAUDE,
  installed: false,
  version: null,
  loggedIn: null,
};

let relay: FakeRelay;

function setup(agents: FakeAgent[] | "legacy", extra: { hostInfoAgents?: string[]; patchStatus?: number } = {}): void {
  relay = installFakeRelay("ok", {
    agentId: "claude",
    control: { agents, ...extra },
  });
}

function mount(props: { remoteHost?: string; onOtherMachine?: () => void } = {}) {
  return render(
    <LocaleProvider>
      <TooltipProvider>
        <AgentsScreen profile={profile} onOtherMachine={props.onOtherMachine ?? (() => {})} remoteHost={props.remoteHost} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setProfiles([profile]);
  __resetFirstRunForTests();
  beginFirstRun();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("Your agents", () => {
  it("keeps the way to another machine while a machine is slow to answer, and gives up after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup([CLAUDE]);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const onOtherMachine = vi.fn();
    mount({ onOtherMachine });
    expect(screen.getByRole("heading", { name: copy.searching })).toBeInTheDocument();
    screen.getByRole("button", { name: copy.otherMachine }).click();
    expect(onOtherMachine).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(21_000);
    expect(await screen.findByText(copy.failed)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows both agents with the first ready one marked, and starts with it", async () => {
    setup([CLAUDE, CODEX_NO_LOGIN]);
    mount();
    expect(screen.getByRole("heading", { name: copy.searching })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.start })).toBeDisabled();

    const claude = await screen.findByRole("radio", { name: "Claude Code" });
    expect(claude).toBeChecked();
    expect(screen.getByRole("radio", { name: "Codex" })).not.toBeChecked();
    expect(screen.getByText("claude · v2.1.3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.bodyMany.replace("{where}", copy.here).replace("{count}", "2"))).toBeInTheDocument();
    expect(screen.getByText(copy.switchNote)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: copy.startWith.replace("{agent}", "Claude Code"),
      }),
    ).toBeEnabled();
  });

  it("marks each agent with its product logo, not letters", async () => {
    setup([CLAUDE, CODEX_NO_LOGIN]);
    mount();
    await screen.findByRole("radio", { name: "Claude Code" });
    const cards = document.querySelectorAll("li[data-state]");
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.querySelector("svg path")).not.toBeNull();
    expect(screen.queryByText("CC")).not.toBeInTheDocument();
    expect(screen.queryByText("CX")).not.toBeInTheDocument();
  });

  it("lets Codex without a login be chosen, shows its command, and does not block Start", async () => {
    setup([CLAUDE, CODEX_NO_LOGIN]);
    mount();
    const codex = await screen.findByRole("radio", { name: "Codex" });
    expect(screen.getByText(copy.state.noLogin)).toBeInTheDocument();
    expect(screen.getByText("codex login")).toBeInTheDocument();
    await userEvent.setup().click(codex);
    expect(codex).toBeChecked();
    expect(
      screen.getByRole("button", {
        name: copy.startWith.replace("{agent}", "Codex"),
      }),
    ).toBeEnabled();
  });

  it("marks the first installed agent when none is signed in", async () => {
    setup([{ ...CLAUDE, loggedIn: false }, CODEX_NO_LOGIN]);
    mount();
    expect(await screen.findByRole("radio", { name: "Claude Code" })).toBeChecked();
  });

  it("with one agent there is no radio, and Start names it", async () => {
    setup([CLAUDE, CODEX_MISSING]);
    mount();
    const start = await screen.findByRole("button", {
      name: copy.startWith.replace("{agent}", "Claude Code"),
    });
    expect(start).toBeEnabled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(copy.switchNote)).not.toBeInTheDocument();
    expect(screen.getByText(copy.bodyOne.replace("{where}", copy.here))).toBeInTheDocument();
    expect(screen.getByText("codex · " + copy.meta.notOnPath)).toBeInTheDocument();
    const how = screen.getByRole("link", {
      name: copy.howToInstall.replace("{agent}", "Codex"),
    });
    expect(how).toHaveAttribute("href", "https://codex.example/cli");
  });

  it("with no agent there is no Start, and Check again appears once", async () => {
    setup([CLAUDE_MISSING, CODEX_MISSING]);
    const onOtherMachine = vi.fn();
    mount({ onOtherMachine });
    expect(await screen.findByRole("heading", { name: copy.none })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(`^${copy.start}`) })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: copy.recheck })).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button", { name: copy.otherMachine }));
    expect(onOtherMachine).toHaveBeenCalledOnce();
  });

  it("Check again asks the relay again and picks up an agent installed in the meantime", async () => {
    setup([CLAUDE_MISSING, CODEX_MISSING]);
    mount();
    await screen.findByRole("heading", { name: copy.none });
    expect(relay.agentChecks()).toBe(1);

    relay.control!.agents = [{ ...CLAUDE }, CODEX_MISSING];
    await userEvent.setup().click(screen.getByRole("button", { name: copy.recheck }));
    expect(
      await screen.findByRole("button", {
        name: copy.startWith.replace("{agent}", "Claude Code"),
      }),
    ).toBeEnabled();
    expect(relay.agentChecks()).toBe(2);
    expect(screen.getAllByRole("button", { name: copy.recheck })).toHaveLength(1);
  });

  it("falls back to /host-info on a relay without the route: installed agents only", async () => {
    setup("legacy", { hostInfoAgents: ["claude"] });
    mount();
    expect(
      await screen.findByRole("button", {
        name: copy.startWith.replace("{agent}", "Claude Code"),
      }),
    ).toBeEnabled();
    expect(screen.queryByText(copy.state.missing)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.state.noLogin)).not.toBeInTheDocument();
  });

  it("names another machine instead of this one", async () => {
    setup([CLAUDE, CODEX_MISSING]);
    mount({ remoteHost: "box.lan" });
    expect(await screen.findByText(copy.bodyOne.replace("{where}", "on box.lan"))).toBeInTheDocument();
    expect(screen.getByText("On box.lan")).toBeInTheDocument();
    expect(screen.getByText(en.firstRun.frame.steps.otherMachine)).toBeInTheDocument();
  });

  it("remembers that the screen is pending until Start", async () => {
    setup([CLAUDE]);
    mount();
    await screen.findByRole("button", {
      name: copy.startWith.replace("{agent}", "Claude Code"),
    });
    expect(getPendingAgentsProfileId()).toBe("default");
  });

  it("is in pt-BR when the language is", async () => {
    localStorage.setItem("anywh:locale", "pt-BR");
    setup([CLAUDE, CODEX_MISSING]);
    mount();
    const pt = ptBr.firstRun.agents;
    expect(
      await screen.findByRole("button", {
        name: pt.startWith.replace("{agent}", "Claude Code"),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(pt.state.missing)).toBeInTheDocument();
  });

  it("Start saves the choice as the profile's default agent, on the relay and here, then hands over the window", async () => {
    setup([CLAUDE, CODEX_NO_LOGIN]);
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Codex" }));
    await user.click(
      screen.getByRole("button", {
        name: copy.startWith.replace("{agent}", "Codex"),
      }),
    );

    await waitFor(() => expect(getFirstRunSnapshot().active).toBe(false));
    expect(relay.patches).toEqual([
      {
        id: "default",
        body: { agentPreference: { mode: "fixed", fixedAgentId: "codex" } },
      },
    ]);
    expect(findProfile("default")?.agentPreference).toEqual({
      mode: "fixed",
      fixedAgentId: "codex",
    });
    expect(getPendingAgentsProfileId()).toBeNull();
    expect(localStorage.getItem("anywh:last-profile")).toBe("default");
  });

  it("still starts when an older relay refuses the preference", async () => {
    setup([CLAUDE], { patchStatus: 400 });
    mount();
    await userEvent.setup().click(
      await screen.findByRole("button", {
        name: copy.startWith.replace("{agent}", "Claude Code"),
      }),
    );
    await waitFor(() => expect(getFirstRunSnapshot().active).toBe(false));
    expect(relay.patches).toHaveLength(1);
  });

  it("the shell's new session starts on the agent chosen here", async () => {
    setup([CLAUDE, CODEX_NO_LOGIN]);
    const first = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Codex" }));
    await user.click(
      screen.getByRole("button", {
        name: copy.startWith.replace("{agent}", "Codex"),
      }),
    );
    await waitFor(() => expect(getFirstRunSnapshot().active).toBe(false));
    first.unmount();

    renderApp();
    await user.click(
      await screen.findByRole("button", {
        name: en.shell.sidebar.newConversation,
      }),
    );
    await waitFor(() =>
      expect(relay.sent.map((s) => s.message)).toContainEqual({
        type: "set_agent",
        agentId: "codex",
      }),
    );
  });
});
