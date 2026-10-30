import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OtherMachine, type ReadySetup } from "@/components/firstrun/OtherMachine";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import { getProfiles, setProfiles } from "@/lib/profiles/profiles";
import { __resetProfileSetupForTests } from "@/lib/profiles/profileSetup";

/**
 * The screen against the real setup queue: only the network is stubbed.
 * An address is the `direct` mode — no claim, no tailnet — so the whole
 * pipeline (save the profile, verify `/sessions`) runs for real.
 */
const MACHINE = { host: "192.168.0.50", port: 8765 };

let machineUp: boolean;

beforeEach(() => {
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  machineUp = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(`${MACHINE.host}:${String(MACHINE.port)}/sessions`) && machineUp) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) } as Response);
      }
      return Promise.reject(new TypeError("connection refused"));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OtherMachine", () => {
  it("asks for nothing but the code, and says which machine it names before sending", async () => {
    const user = userEvent.setup();
    render(<OtherMachine onAdvanced={() => {}} onReady={() => {}} />);

    const connect = screen.getByRole("button", { name: en.firstRun.other.connect });
    expect(connect).toBeDisabled();
    expect(screen.getByText(en.firstRun.other.code.empty)).toBeInTheDocument();

    await user.type(screen.getByLabelText(en.firstRun.other.code.label), "not-a-code");
    expect(screen.getByText(en.firstRun.other.code.invalid)).toBeInTheDocument();
    expect(connect).toBeDisabled();

    const input = screen.getByLabelText(en.firstRun.other.code.label);
    await user.clear(input);
    await user.type(input, "ABCDEF-GHJKMNPQ@casa.example.com");
    expect(screen.getByText("casa.example.com")).toBeInTheDocument();
    expect(connect).toBeEnabled();
  });

  it("connects by address with inline progress and hands over the verified profile", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn<(setup: ReadySetup) => void>();
    render(<OtherMachine initialMode="address" onAdvanced={() => {}} onReady={onReady} />);

    await user.type(screen.getByLabelText(en.firstRun.other.address.host, { selector: "input" }), MACHINE.host);
    await user.click(screen.getByRole("button", { name: en.firstRun.other.connect }));

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(onReady.mock.calls[0][0].profile.host).toBe(MACHINE.host);
    expect(getProfiles()).toHaveLength(1);
    // The progress is drawn on this screen, not in a dialog, and an address
    // has no claim row.
    expect(screen.getByText(en.firstRun.other.steps.verifying)).toBeInTheDocument();
    expect(screen.queryByText(en.firstRun.other.steps.claiming)).not.toBeInTheDocument();
  });

  it("says what failed, keeps the profile and finishes on retry", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    machineUp = false;
    render(<OtherMachine initialMode="address" initialHost={MACHINE.host} initialPort={MACHINE.port} onAdvanced={() => {}} onReady={onReady} />);

    await user.click(screen.getByRole("button", { name: en.firstRun.other.connect }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.firstRun.other.failed.verify);
    expect(onReady).not.toHaveBeenCalled();

    machineUp = true;
    await user.click(screen.getByRole("button", { name: en.firstRun.other.retry }));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(getProfiles()).toHaveLength(1);
  });

  it("opens on the address tab with host and port when handed over from the terminal path", () => {
    render(<OtherMachine initialMode="address" initialHost="127.0.0.1" initialPort={9000} onAdvanced={() => {}} onReady={() => {}} />);
    expect(screen.getByLabelText(en.firstRun.other.address.host, { selector: "input" })).toHaveValue("127.0.0.1");
    expect(screen.getByLabelText(en.firstRun.other.address.port)).toHaveValue("9000");
  });

  it("leads to the advanced options", async () => {
    const user = userEvent.setup();
    const onAdvanced = vi.fn();
    render(<OtherMachine onAdvanced={onAdvanced} onReady={() => {}} />);
    await user.click(screen.getByRole("button", { name: en.firstRun.other.advanced }));
    expect(onAdvanced).toHaveBeenCalledTimes(1);
  });

  it("never says relay outside the advanced options, in either language", () => {
    for (const dict of [en, ptBr]) {
      expect(JSON.stringify(dict.firstRun.other).toLowerCase()).not.toContain("relay");
    }
  });
});
