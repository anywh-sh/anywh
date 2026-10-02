/**
 * Integer, not semver — relay and client ship from the same repo and the
 * same release, so there is no compatibility range to express, only "same"
 * or "different". Bump this whenever a wire vocabulary change would make an
 * older client misinterpret a message instead of just not knowing about it
 * yet (see docs/invariants.md).
 *
 * Mirrored verbatim at client/src/lib/relay/protocolVersion.ts — there is no
 * shared package between the two npm projects (see docs/architecture.md) —
 * and protocolVersionParity.test.ts keeps the two copies from drifting apart
 * in silence.
 *
 * 1 -> 2: added the `context_attribution` AgentEvent variant. Bumped (not
 * left alone the way the `usage` variant's new fields were) because an old
 * client's `applyAgentEvent` (useMessageLog.ts) is a switch with no
 * `default`/trailing `return` — an unrecognized variant falls through and
 * returns `undefined` as the reducer's new state, crashing the next render,
 * not just ignoring the event. Fixed alongside this bump (the switch now
 * has a trailing `return state;`), but that only protects a FUTURE version
 * skew — it does nothing for clients already installed when this shipped,
 * which is why the bump itself still has to happen.
 *
 * 2 -> 3: tool calls, reasoning and turns started carrying timing and an
 * interpreted `subject`/`outcome`, plus the new `thinking_started` variant.
 * An older client wouldn't crash on any of it (the trailing `return state;`
 * above), but it would silently render a turn without the parts it doesn't
 * know — a client that looks fine while missing what the relay sent is
 * exactly the skew this number exists to surface as "update the app".
 */
export const WS_PROTOCOL_VERSION = 3;
