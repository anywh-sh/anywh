import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddRemoteMachineDialog } from "./AddRemoteMachineDialog";
import { __resetProfileSetupForTests, getProfileSetupState } from "@/lib/profiles/profileSetup";
import { en } from "@/i18n/en";

// The setup queue runs for real; only the network edge is stubbed, and it
// never answers, so the request stays at "connecting" with the profile it
// was given.

const copy = en.shell.profiles.pair;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetProfileSetupForTests();
  localStorage.clear();
});

describe("AddRemoteMachineDialog", () => {
  it("adds a machine by address after first run, straight to its relay", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddRemoteMachineDialog open onOpenChange={onOpenChange} />);
    const body = within(document.body);

    await user.type(body.getByLabelText(copy.nameLabel), "Home server");
    await user.click(body.getByRole("tab", { name: copy.modeAddress }));
    const connect = body.getByRole("button", { name: copy.connect });
    expect(connect).toBeDisabled();
    await user.type(body.getByLabelText(copy.hostLabel), "192.168.0.48");
    await user.clear(body.getByLabelText(copy.portLabel));
    await user.type(body.getByLabelText(copy.portLabel), "8811");
    await user.click(connect);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      const state = getProfileSetupState().state;
      expect(state && "profile" in state ? { label: state.profile.label, host: state.profile.host, port: state.profile.relayPort } : null).toEqual({
        label: "Home server",
        host: "192.168.0.48",
        port: 8811,
      });
    });
  });

  it("refuses an address that can't be one, and a port out of range", async () => {
    const user = userEvent.setup();
    render(<AddRemoteMachineDialog open onOpenChange={() => {}} />);
    const body = within(document.body);

    await user.type(body.getByLabelText(copy.nameLabel), "Home server");
    await user.click(body.getByRole("tab", { name: copy.modeAddress }));
    await user.type(body.getByLabelText(copy.hostLabel), "not an address");
    expect(body.getByText(copy.hostInvalid)).toBeInTheDocument();
    expect(body.getByRole("button", { name: copy.connect })).toBeDisabled();

    await user.clear(body.getByLabelText(copy.hostLabel));
    await user.type(body.getByLabelText(copy.hostLabel), "192.168.0.48");
    await user.clear(body.getByLabelText(copy.portLabel));
    await user.type(body.getByLabelText(copy.portLabel), "70000");
    expect(body.getByRole("button", { name: copy.connect })).toBeDisabled();
  });
});
