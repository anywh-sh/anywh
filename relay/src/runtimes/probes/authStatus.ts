/** `claude auth status --json`'s payload, verbatim — three of its fields,
 * the ones this repo reads. Kept Claude-shaped on purpose: the generic
 * shape every runtime answers in is `AuthStatus` (`runtimes/types.ts`), and
 * `defs/claude/def.ts` is the one place that maps between the two. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

/** Pure parse of `claude auth status --json`'s stdout — lives here rather
 * than inline in the def so a test can exercise the payload shape without
 * going near a process. Throws on invalid JSON; `probeRuntimeAuth`
 * (runtimes/probes/runtimeAuth.ts) turns that into a rejected promise, so
 * an unparseable reply reads as "couldn't check", never as "logged out". */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  return JSON.parse(stdout) as ClaudeAuthStatus;
}

/** The CLI's own words for "this login can't make the turn" ("Not logged in
 * · Please run /login", "Invalid API key"), plus the API's
 * `authentication_error`/401 for an expired or revoked token. One
 * definition for a chat turn's failure class (`defs/claude/def.ts`) and for
 * the plan usage probe, which reads the same failures off its own turn. */
export const CLAUDE_SIGNED_OUT_PATTERN = /not logged in|\/login|authentication_error|oauth token|token (has )?expired|\b401\b/i;
export const CLAUDE_API_KEY_PATTERN = /invalid api key|x-api-key/i;
