// Resolves a native `ApprovalDecision.labelKey` to English display text.
// Kept as its own pure function rather than inline in `sharedSession.ts` so
// it's unit-testable without constructing a `SharedSession` — same
// testability principle `runtimes/README.md` §2/§8 asks of a def's own
// functions, applied one layer up. There is no working generic `labelKey`
// resolution pipe anywhere in this codebase yet (the client's permission-mode
// dropdown, the other place a def declares a `labelKey`, is driven by a
// client-hardcoded table keyed on Claude's own literal union, never by
// resolving the wire value) — this hardcoded table is deliberately the same
// shape as `defs/claude/mcpSpawnConfig.ts`'s `APPROVE_OPTION_ID`/`DENY_OPTION_ID`
// pair, not a new generic mechanism.
const DECISION_LABELS: Readonly<Record<string, string>> = {
  "codex.decision.accept": "Accept",
  "codex.decision.acceptForSession": "Accept for this session",
  "codex.decision.decline": "Decline",
  "codex.decision.cancel": "Cancel",
};

/** Falls back to the raw key for one it doesn't recognize — same fallback
 * discipline `describeToolCall` uses for an unrecognized tool, so an
 * unmapped key is a visible bug on screen instead of a silent crash. */
export function resolveDecisionLabel(labelKey: string): string {
  return DECISION_LABELS[labelKey] ?? labelKey;
}
