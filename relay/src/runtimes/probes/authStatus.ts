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
