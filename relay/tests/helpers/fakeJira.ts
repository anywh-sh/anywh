// The environment of a relay whose profile has Jira, for the tests that
// drive it through an agent's turns: the fake `claude` lists the recorded
// inventory (claude.ai Atlassian connected) and answers Atlassian tools from
// fixtures/fake-atlassian.mjs, and a `codex` wrapper on the PATH runs the
// fake app-server — never a real CLI the machine has.
import { accessSync, chmodSync, constants, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import WebSocket from "ws";
import { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } from "../../src/integrations/inventory/fixtures.js";
import type { IntegrationState } from "../../src/integrations/types.js";

const FAKE_CODEX = resolve(import.meta.dirname, "../fixtures/fake-codex-app-server.mjs");

/** The Atlassian site the fakes answer for (fixtures/fake-atlassian.mjs). */
export const FAKE_JIRA_SITE = { id: "00000000-0000-4000-8000-0000000000a1", url: "https://example-team.atlassian.net", name: "example-team" };

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Writes the fakes' files under `work` and returns the relay's env. */
export function fakeJiraEnv(work: string): Record<string, string> {
  const home = join(work, "home");
  const binDir = join(work, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // The fake claude runs through `#!/usr/bin/env node`: this test's node goes
  // first, since a directory holding a real `codex` is dropped below.
  symlinkSync(process.execPath, join(binDir, "node"));
  writeFileSync(join(binDir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  chmodSync(join(binDir, "codex"), 0o755);
  const files = { claudeStatus: join(work, "claude-mcp-status.json"), codexList: join(work, "codex-mcp-list.json"), codexStatus: join(work, "codex-mcp-status.json") };
  writeFileSync(files.claudeStatus, JSON.stringify(CLAUDE_MCP_STATUS_SETTLED));
  writeFileSync(files.codexList, JSON.stringify((JSON.parse(CODEX_MCP_LIST_STDOUT) as { name: string }[]).filter((server) => server.name !== "jira-local")));
  writeFileSync(files.codexStatus, JSON.stringify({ ...CODEX_MCP_STATUS_LIST, data: CODEX_MCP_STATUS_LIST.data.filter((server) => server.name !== "jira-local") }));
  const inheritedPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !isExecutable(join(entry, "codex")));
  return {
    // The relay looks for agent CLIs in a few per-user folders under $HOME
    // too: never the real one's.
    HOME: home,
    RELAY_HOME_OVERRIDE: home,
    RELAY_SESSIONS_FILE: join(work, "sessions.json"),
    RELAY_WAKEUPS_FILE: join(work, "wakeups.json"),
    RELAY_PUSH_DEVICES_FILE: join(work, "push-devices.json"),
    PATH: [binDir, ...inheritedPath].join(delimiter),
    EXTRA_PATH_DIRS: "",
    FAKE_CLAUDE_MCP_STATUS_FILE: files.claudeStatus,
    FAKE_CODEX_MCP_LIST_FILE: files.codexList,
    FAKE_CODEX_MCP_STATUS_FILE: files.codexStatus,
  };
}

/** The prompt marker that makes the fake `claude` call an MCP tool. */
export function mcpCallMarker(server: string, tool: string, input: Record<string, unknown>): string {
  return `[[mcp:${server}:${tool}:${Buffer.from(JSON.stringify(input)).toString("base64url")}]]`;
}

type StateMessage = { type: "integrations_state"; integrations: IntegrationState[] };
export const jiraOf = (message: Record<string, unknown>): IntegrationState | undefined =>
  message.type === "integrations_state" ? (message as unknown as StateMessage).integrations.find((integration) => integration.id === "jira") : undefined;

/** Every message of a socket from now on, and a wait for one that matches,
 * among those received since a mark. */
export function recorder(socket: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.on("message", (raw: Buffer) => {
    messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    for (const wake of [...waiters]) wake();
  });
  return {
    messages,
    /** Where the messages received from now on start. */
    mark(): number {
      return messages.length;
    },
    /** The first message from `since` on that satisfies `until`. */
    waitFor(until: (message: Record<string, unknown>) => boolean, since = 0, timeoutMs = 10_000): Promise<Record<string, unknown>> {
      return new Promise((resolveWait, reject) => {
        const wake = (): void => {
          const found = messages.slice(since).find(until);
          if (!found) return;
          waiters.delete(wake);
          clearTimeout(timer);
          resolveWait(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`no matching message within ${timeoutMs}ms; got: ${JSON.stringify(messages.slice(since).slice(-10))}`));
        }, timeoutMs);
        waiters.add(wake);
        wake();
      });
    },
  };
}

/** Opens a socket and records it from its very first message. */
export function openRecorded(port: number, path: string): Promise<{ socket: WebSocket; recorded: ReturnType<typeof recorder> }> {
  return new Promise((resolveOpen, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const recorded = recorder(socket);
    socket.once("open", () => resolveOpen({ socket, recorded }));
    socket.once("error", reject);
  });
}
