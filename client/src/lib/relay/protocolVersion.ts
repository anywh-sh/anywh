/**
 * Integer, not semver — relay and client ship from the same repo and the
 * same release, so there is no compatibility range to express, only "same"
 * or "different". Bump this whenever a wire vocabulary change would make an
 * older client misinterpret a message instead of just not knowing about it
 * yet (see docs/invariants.md).
 *
 * Mirrored verbatim at relay/src/protocol/version.ts — there is no shared
 * package between the two npm projects (see docs/architecture.md) — and
 * protocolVersionParity.test.ts keeps the two copies from drifting apart in
 * silence.
 *
 * 1 -> 2: added the `context_attribution` AgentEvent variant — see the
 * relay's copy of this comment for why an old client's `useMessageLog.ts`
 * needed the bump, not just the new variant.
 */
export const WS_PROTOCOL_VERSION = 2;
