import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState, type ReactNode } from "react";
import { AddProfileDialog } from "@/components/shell/AddProfileDialog";
import type { Profile } from "@/lib/profiles/profiles";

const activeProfile: Profile = { id: "pessoal", label: "Personal", host: "127.0.0.1", relayPort: 8788 };

interface FakeRelayOptions {
  loggedIn: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A relay that answers what the dialog asks, with a short delay so the
 * loading states show: three agents, a draft, a sign-in check, a create.
 * Installed over `window.fetch` while the story is mounted, and restored
 * when it unmounts so it never leaks into the next story. */
function FakeRelay({ options, children }: { options: FakeRelayOptions; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (url.pathname === "/host-info") {
        return json({ hostname: "box", platform: "linux", editor: null, agents: ["claude", "codex", "kimi"].map((id) => ({ id, capabilities: {} })) });
      }
      if (url.pathname === "/control/profiles/draft") return json({ id: "client-x" });
      if (url.pathname.startsWith("/control/profiles/draft/")) return json({ ok: true });
      if (url.pathname === "/control/profiles/validate") {
        return json(options.loggedIn ? { loggedIn: true, account: "work@example.com", plan: "max" } : { loggedIn: false });
      }
      if (url.pathname === "/control/profiles") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { label: string };
        return json({ id: "client-x", label: body.label, host: "127.0.0.1", port: 8790, colorIndex: 2 });
      }
      if (url.pathname === "/control/portability") {
        return json({ runtimeId: "claude", found: true, files: [{ path: ".claude/CLAUDE.md", bytes: 12 }], mcpServers: ["sentry"], warnings: [] });
      }
      return json({ error: "not in this story" }, 404);
    };
    setReady(true);
    return () => {
      window.fetch = original;
    };
  }, [options]);
  return ready ? children : null;
}

/** Reopens the dialog after it closes, so a click-through can be repeated. */
function Reopening({ loggedIn }: { loggedIn: boolean }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setOpen(true), 800);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <FakeRelay options={{ loggedIn }}>
      <AddProfileDialog open={open} onOpenChange={setOpen} activeProfile={activeProfile} />
    </FakeRelay>
  );
}

const meta = {
  title: "Shell/AddProfileDialog",
  component: Reopening,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-screen bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Reopening>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole flow against a relay that answers: name, agent, what to keep
 * from this machine (all separate by default), Continue, the account check,
 * Create. Advanced holds the older custom-home path. */
export const Simulated: Story = { args: { loggedIn: true } };

/** The picked agent isn't signed in in the new profile's folders yet: the
 * account step offers to connect it. */
export const SignedOut: Story = { args: { loggedIn: false } };
