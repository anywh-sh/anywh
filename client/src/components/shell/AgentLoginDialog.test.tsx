import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoginDialog, codeIsInLink, reduceAgentLogin, type AgentLoginTarget } from "./AgentLoginDialog";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles/profiles";

const trackFeature = vi.hoisted(() => vi.fn());
const trackError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/instrument", () => ({ trackFeature, trackError }));
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

// The socket is stubbed (the network edge); the dialog is real. Pinned: the
// URL it opens, the three per-agent second steps, the code going back as a
// `code` frame, and what each outcome says.

const copy = en.shell.profiles.agentLogin;
const profile: Profile = { id: "work", label: "Work", host: "100.64.0.7", relayPort: 8790 };
const target = (runtimeId: string): AgentLoginTarget => ({ profile, runtimeId });

class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(frame: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }
}

async function socket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0));
  return FakeSocket.opened[FakeSocket.opened.length - 1];
}

beforeEach(() => {
  trackFeature.mockClear();
  trackError.mockClear();
  openUrl.mockClear();
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const body = () => within(document.body);

describe("AgentLoginDialog", () => {
  it("opens the login on the profile's own relay, for the agent asked", async () => {
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("claude")} />);
    expect((await socket()).url).toBe("ws://100.64.0.7:8790/agent-login?runtime=claude");
    expect(body().getByText("Sign in to Claude Code")).toBeInTheDocument();
    expect(body().getByText(copy.connecting)).toBeInTheDocument();
  });

  it("Claude: open the page here, paste the code back, and the account it signed in to", async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("claude")} onSignedIn={onSignedIn} />);
    const ws = await socket();
    ws.emit({ type: "prompt", url: "https://claude.com/cai/oauth/authorize?state=x", input: "code" });

    await user.click(body().getByRole("link", { name: copy.openPage }));
    expect(openUrl).toHaveBeenCalledWith("https://claude.com/cai/oauth/authorize?state=x");

    await user.type(body().getByLabelText(copy.pasteLabel), "  abc#def  ");
    await user.click(body().getByRole("button", { name: copy.submit }));
    expect(ws.sent).toEqual([JSON.stringify({ type: "code", value: "abc#def" })]);
    expect(body().getByText(copy.checking)).toBeInTheDocument();

    ws.emit({ type: "done", account: "me@example.com", plan: "max" });
    expect(body().getByRole("status")).toHaveTextContent("Connected as me@example.com");
    expect(onSignedIn).toHaveBeenCalledWith(target("claude"));
    expect(trackFeature).toHaveBeenCalledWith("agent_signin");
  });

  it("Codex: a code to type into the page, and no field to paste into", async () => {
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("codex")} />);
    (await socket()).emit({ type: "prompt", url: "https://auth.openai.com/codex/device", userCode: "KRXE-WAQOM", input: "none" });
    expect(body().getByText(copy.enterCode)).toBeInTheDocument();
    expect(body().getByText("KRXE-WAQOM")).toBeInTheDocument();
    expect(body().getByText(copy.waiting)).toBeInTheDocument();
    expect(body().queryByLabelText(copy.pasteLabel)).not.toBeInTheDocument();
  });

  it("Kimi: the link already carries the code, so the code is only there to compare", async () => {
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("kimi")} />);
    (await socket()).emit({ type: "prompt", url: "https://www.kimi.ai/code/authorize_device?user_code=KBD0-XD2T", userCode: "KBD0-XD2T", input: "none" });
    expect(body().getByText(copy.checkCode)).toBeInTheDocument();
  });

  it("a refused code offers to start over, on a new socket", async () => {
    const user = userEvent.setup();
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("claude")} />);
    const first = await socket();
    first.emit({ type: "prompt", url: "https://claude.com/x", input: "code" });
    first.emit({ type: "rejected", detail: "Login failed: That code wasn't accepted." });
    expect(body().getByRole("alert")).toHaveTextContent(copy.rejected);

    await user.click(body().getByRole("button", { name: copy.tryAgain }));
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(2));
    expect(first.closed).toBe(true);
  });

  it("a socket that closes before an answer reads as an unreachable machine", async () => {
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("claude")} />);
    const ws = await socket();
    act(() => ws.close());
    expect(await body().findByRole("alert")).toHaveTextContent(copy.unreachable);
  });

  it("a login taken over by another device says so, without offering to start over", async () => {
    render(<AgentLoginDialog open onOpenChange={() => {}} target={target("claude")} />);
    (await socket()).emit({ type: "error", reason: "superseded" });
    expect(body().getByRole("alert")).toHaveTextContent(copy.superseded);
    expect(body().queryByRole("button", { name: copy.tryAgain })).not.toBeInTheDocument();
    expect(trackError).not.toHaveBeenCalled();
  });

  it("closing the dialog closes the socket, which ends the login on the relay", async () => {
    const { rerender } = render(<AgentLoginDialog open onOpenChange={() => {}} target={target("claude")} />);
    const ws = await socket();
    rerender(<AgentLoginDialog open={false} onOpenChange={() => {}} target={target("claude")} />);
    expect(ws.closed).toBe(true);
  });
});

describe("reduceAgentLogin", () => {
  it("keeps the CLI's output only while there is no prompt", () => {
    const connecting = reduceAgentLogin({ step: "connecting", output: "", showOutput: false }, { type: "output", data: "hi\n" });
    expect(connecting).toEqual({ step: "connecting", output: "hi\n", showOutput: false });
    const prompted = reduceAgentLogin(connecting, { type: "prompt", url: "https://a.test", input: "code" });
    expect(reduceAgentLogin(prompted, { type: "output", data: "more" })).toBe(prompted);
  });

  it("tells a code carried by the link from one to type", () => {
    expect(codeIsInLink({ type: "prompt", url: "https://a.test/?user_code=AB-CD", userCode: "AB-CD", input: "none" })).toBe(true);
    expect(codeIsInLink({ type: "prompt", url: "https://a.test/device", userCode: "AB-CD", input: "none" })).toBe(false);
  });
});
