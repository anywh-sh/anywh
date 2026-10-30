import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdvancedOptions } from "@/components/firstrun/AdvancedOptions";
import { en } from "@/i18n/en";

/**
 * The native edge is the only thing stubbed: whether an in-app install
 * exists, which interfaces the machine answers on, and the platform.
 */
const native = vi.hoisted(() => ({
  possible: true,
  platform: "linux",
  addresses: [] as Array<{ address: string; kind: string; interface: string; recommended: boolean }>,
}));

vi.mock("@/lib/install/localRelay", () => ({
  localInstallPossible: () => native.possible,
  suggestAddresses: () => Promise.resolve(native.addresses),
}));
vi.mock("@/lib/platform/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/platform")>()),
  currentPlatform: () => native.platform,
}));

const copy = en.firstRun.advanced;

beforeEach(() => {
  native.possible = true;
  native.platform = "linux";
  native.addresses = [];
});

afterEach(cleanup);

describe("AdvancedOptions", () => {
  it("installs through the app with the defaults when nothing is touched", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(<AdvancedOptions onInstall={onInstall} onConnect={() => {}} />);

    expect(screen.getByRole("radio", { name: new RegExp(copy.address.loopback) })).toBeChecked();
    // No Tailnet row unless one was detected.
    expect(screen.queryByRole("radio", { name: new RegExp(copy.address.tailnet) })).not.toBeInTheDocument();
    expect(screen.getByLabelText(copy.port)).toBeDisabled();

    await user.click(screen.getByRole("button", { name: copy.app.cta }));
    expect(onInstall).toHaveBeenCalledWith({ label: en.firstRun.profile.defaultLabel, host: "127.0.0.1", profileId: undefined, mode: "prod" });
  });

  it("offers the detected interfaces and passes the chosen address, name and dev mode on", async () => {
    native.addresses = [
      { address: "192.168.1.24", kind: "lan", interface: "eth0", recommended: false },
      { address: "100.84.12.7", kind: "tailnet", interface: "tailscale0", recommended: true },
    ];
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(<AdvancedOptions onInstall={onInstall} onConnect={() => {}} />);

    await user.click(await screen.findByRole("radio", { name: new RegExp(copy.address.tailnet) }));
    const name = screen.getByLabelText(copy.profileName);
    await user.clear(name);
    await user.type(name, "Work box");
    await user.click(screen.getByRole("checkbox", { name: new RegExp(copy.devMode.label) }));
    await user.click(screen.getByRole("button", { name: copy.app.cta }));

    expect(onInstall).toHaveBeenCalledWith({ label: "Work box", host: "100.84.12.7", profileId: "work-box", mode: "dev" });
  });

  it("takes a custom address and refuses one with spaces", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(<AdvancedOptions onInstall={onInstall} onConnect={() => {}} />);

    await user.click(screen.getByRole("radio", { name: new RegExp(copy.address.custom) }));
    const cta = screen.getByRole("button", { name: copy.app.cta });
    expect(cta).toBeDisabled();
    await user.type(screen.getByLabelText(copy.address.custom, { selector: "input" }), "relay.casa.example");
    await user.click(cta);
    expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({ host: "relay.casa.example" }));
  });

  it("spells the install out as commands for the chosen address and connects on the chosen port", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(<AdvancedOptions initialInstall="terminal" onInstall={() => {}} onConnect={onConnect} />);

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("curl -fsSL https://anywh.sh/install | sh")).toBeInTheDocument();
    expect(within(panel).getByText(/add-profile\.sh default --relay-host 127\.0\.0\.1 --port 8765$/)).toBeInTheDocument();
    expect(within(panel).queryByText(copy.terminal.wsl)).not.toBeInTheDocument();

    const port = screen.getByLabelText(copy.port);
    expect(port).toBeEnabled();
    await user.clear(port);
    await user.type(port, "9000");
    expect(screen.getByText(copy.terminal.connectAfter.replace("{host}", "127.0.0.1").replace("{port}", "9000"))).toBeInTheDocument();
    // The port the connect will dial is the one the profile is created on.
    expect(within(panel).getByText(/add-profile\.sh default --relay-host 127\.0\.0\.1 --port 9000$/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.terminal.done }));
    expect(onConnect).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9000 });
  });

  it("has only the terminal where the app cannot install, and says WSL2 on Windows", () => {
    native.possible = false;
    native.platform = "windows";
    render(<AdvancedOptions onInstall={() => {}} onConnect={() => {}} />);

    expect(screen.queryByRole("tab", { name: copy.install.app })).not.toBeInTheDocument();
    expect(screen.getByText(copy.terminal.wsl)).toBeInTheDocument();
    expect(screen.getByText("curl -fsSL https://anywh.sh/install | sh")).toBeInTheDocument();
  });

  it("uses the Homebrew formula on macOS and keeps the profile id fixed", () => {
    native.platform = "macos";
    render(<AdvancedOptions initialInstall="terminal" onInstall={() => {}} onConnect={() => {}} />);
    expect(screen.getByText("brew install anywh-sh/tap/anywh-relay")).toBeInTheDocument();
    expect(screen.getByText(/add-profile\.sh" default --mode dev --relay-host 127\.0\.0\.1 --port 8765$/)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.profileName)).toBeDisabled();
  });
});
