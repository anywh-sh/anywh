import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpSignInDialog, type McpSignInTarget } from "./McpSignInDialog";
import { en } from "@/i18n/en";

// Same boundary as every other component test here: the socket is stubbed,
// the dialog is real. What's worth pinning is the contract with the relay
// — one socket per server, the URL it's opened with, the output shown
// verbatim, and the pasted line going back as an `input` frame.

const copy = en.shell.profiles.mcpSignIn;

const target: McpSignInTarget = {
  host: "127.0.0.1",
  port: 8788,
  runtimeId: "claude",
  home: "/home/user/.anywh-client-x",
  servers: ["sentry", "linear"],
};

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
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function body() {
  return within(document.body);
}

describe("McpSignInDialog", () => {
  it("lists every server the setup brought, one sign-in at a time", () => {
    render(<McpSignInDialog open onOpenChange={() => {}} target={target} />);
    expect(body().getByText("sentry")).toBeInTheDocument();
    expect(body().getByText("linear")).toBeInTheDocument();
    expect(body().getAllByRole("button", { name: copy.signIn })).toHaveLength(2);
  });

  it("opens the login against the new profile's home, not the active one's", async () => {
    const user = userEvent.setup();
    render(<McpSignInDialog open onOpenChange={() => {}} target={target} />);

    await user.click(body().getAllByRole("button", { name: copy.signIn })[0]);
    // Signing in under the wrong home would write the session into a
    // profile the user wasn't setting up, and look like it worked.
    expect(FakeSocket.opened[0].url).toBe(
      "ws://127.0.0.1:8788/mcp-login?runtime=claude&server=sentry&home=%2Fhome%2Fuser%2F.anywh-client-x",
    );
  });

  it("shows what the CLI printed, and sends back what the user pasted as a line", async () => {
    const user = userEvent.setup();
    render(<McpSignInDialog open onOpenChange={() => {}} target={target} />);
    await user.click(body().getAllByRole("button", { name: copy.signIn })[0]);

    const socket = FakeSocket.opened[0];
    socket.emit({ type: "data", data: "Open this URL:\nhttps://auth.example/authorize?x=1\n" });
    expect(await screen.findByText(/https:\/\/auth\.example\/authorize/)).toBeInTheDocument();

    await user.type(body().getByLabelText(copy.pastePlaceholder), "https://localhost:9999/callback?code=abc");
    await user.click(body().getByRole("button", { name: copy.send }));

    // The trailing carriage return matters: the other end is a CLI reading
    // a line, and without it the login simply keeps waiting.
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "input", data: "https://localhost:9999/callback?code=abc\r" });
  });

  it("reports the outcome from the exit code, not from the text", async () => {
    const user = userEvent.setup();
    render(<McpSignInDialog open onOpenChange={() => {}} target={target} />);
    await user.click(body().getAllByRole("button", { name: copy.signIn })[0]);

    FakeSocket.opened[0].emit({ type: "exit", code: 0 });
    expect(await screen.findByText(copy.signedIn)).toBeInTheDocument();
  });

  it("a refused login reads as not finished rather than as success", async () => {
    const user = userEvent.setup();
    render(<McpSignInDialog open onOpenChange={() => {}} target={target} />);
    await user.click(body().getAllByRole("button", { name: copy.signIn })[0]);

    FakeSocket.opened[0].emit({ type: "error", error: "unknown runtime" });
    expect(await screen.findByText(copy.failed)).toBeInTheDocument();
  });

  it("closing the dialog ends a login left half-finished", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<McpSignInDialog open onOpenChange={() => {}} target={target} />);
    await user.click(body().getAllByRole("button", { name: copy.signIn })[0]);

    rerender(<McpSignInDialog open={false} onOpenChange={() => {}} target={target} />);
    // The relay kills the child when the socket closes; an abandoned OAuth
    // flow left running holds a callback listener nobody will reach.
    await waitFor(() => expect(FakeSocket.opened[0].closed).toBe(true));
  });
});
