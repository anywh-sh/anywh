// Pure functions extracted out of `SharedSession` for the same reason
// `nativeApproval.ts`/`approvalLabels.ts` were (Phase 11): `sharedSession.ts`
// has no unit-test harness of its own, so the "which modes does this session
// offer, and which one should it start in" logic lives here instead, where a
// table test can exercise it against a fake def without constructing a
// SharedSession.
import type { AgentRuntimeDef, HostPlatform } from "../runtimes/types.js";

/** What the client needs to render a mode dropdown for this session's agent:
 * an id it can resolve to text (client/src/i18n, keyed by id — same
 * id-switch precedent `ChoiceCard.tsx`'s `labelOf` set for
 * `ApprovalDecision`), and the one behavioral bit the UI actually branches
 * on. `labelKey` is deliberately NOT here: shipping it would create a
 * second, competing label-resolution mechanism next to the one Phase 11
 * already established (see `approvalLabels.ts`'s "no working generic
 * labelKey pipe" note). */
export interface PermissionModeOption {
  readonly id: string;
  readonly pausesForApproval: boolean;
}

export function availableModes(def: AgentRuntimeDef, platform: HostPlatform): readonly PermissionModeOption[] {
  return def.permissions.modesFor(platform).map((mode) => ({ id: mode.id, pausesForApproval: mode.pausesForApproval }));
}

export function isOfferedMode(modes: readonly PermissionModeOption[], id: string): boolean {
  return modes.some((mode) => mode.id === id);
}

/** A persisted mode this platform doesn't offer (a record written on Linux,
 * read on win32, where Codex has no `workspace-write`) falls back to the
 * def's own default; a default that this platform also doesn't offer falls
 * back to the first mode offered — every def's `modesFor` is required to
 * return a non-empty list on every platform it runs on, so that fallback
 * always has something to land on. */
export function resolveInitialMode(modes: readonly PermissionModeOption[], persisted: string, defaultModeId: string): string {
  if (isOfferedMode(modes, persisted)) return persisted;
  if (isOfferedMode(modes, defaultModeId)) return defaultModeId;
  return modes[0].id;
}
