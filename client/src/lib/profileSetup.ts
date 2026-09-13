import { claimAndSaveProfile, resolvePairingCodeParams, type ImportedProfileParams } from "@/lib/profileImport";
import { parsePairingCode } from "@/lib/pairingCode";
import { resolveConnection } from "@/lib/connectionResolver";
import { resolveTailnetTarget } from "@/lib/tailnetBroker";
import { acquireTailnetSidecar, releaseTailnetSidecar } from "@/lib/tailnetSidecar";
import { fetchControlProfiles, fetchSessions } from "@/lib/relayClient";
import type { Profile } from "@/lib/profiles";

/**
 * Drives a new profile from "a join code or code just arrived" to "ready to
 * switch to", outside React entirely (see the module doc below for why).
 * The two entry points — a deep link (`useProfileImport`) and a typed
 * pairing code (`AddRemoteMachineDialog`) — both call `enqueueProfileSetup`
 * and never touch `claimAndSaveProfile`/`resolveTailnetTarget`/
 * `acquireTailnetSidecar` directly again; this module owns the whole
 * claim → connect → verify pipeline and the one profile switcher that used
 * to happen silently the moment a join code resolved.
 *
 * Deliberately module-level, not a hook or a component: no React effect
 * here means neither StrictMode's synchronous double-mount nor the setup
 * dialog unmounting mid-flight (the user closed it) can ever duplicate a
 * claim or cancel one in progress. `ProfileSetupDialog` (upcoming) is only
 * ever a read of `getProfileSetupState()` — it can be unmounted and
 * remounted freely without the pipeline underneath noticing.
 */

export type SetupMode = "tailnet" | "direct";

export interface VerifiedInfo {
  /** How many sessions the newly reachable machine already has — the one
   * piece of real, machine-specific info cheap enough to always show on the
   * success screen (already fetched as part of verification itself). */
  sessionCount: number;
}

export type SetupState =
  | { status: "claiming"; mode: SetupMode }
  | { status: "connecting"; mode: SetupMode; profile: Profile }
  | { status: "verifying"; mode: SetupMode; profile: Profile }
  | { status: "ready"; mode: SetupMode; profile: Profile; info: VerifiedInfo; duplicates: Profile[] }
  /** Terminal — the join code itself was never redeemed (or a typed code
   * never resolved to a `claimUrl` in the first place), so no profile was
   * ever saved. Nothing to retry: the code is either unspent (dismiss and
   * try again with a fresh one) or was never valid. */
  | { status: "failed"; mode: SetupMode; stage: "claim" }
  /** Recoverable — the code was already spent and the profile already
   * saved by the time either of these steps could fail, so `retryProfileSetup`
   * re-enters at `connectStep` with this same profile instead of asking for
   * a new code. */
  | { status: "failed"; mode: SetupMode; stage: "connect" | "verify"; profile: Profile };

export interface ProfileSetupSnapshot {
  state: SetupState | null;
  /** Requests waiting behind whichever one `state` describes — the footer's
   * "+N" count. Excludes the one currently running. */
  queuedCount: number;
}

/**
 * A deep link already carries fully-resolved params (`parseImportProfileUrl`
 * did the parsing); a typed pairing code hasn't even been through discovery
 * yet — `resolvePairingCodeParams` runs as part of the claim step below, not
 * before enqueueing, so a typo can't burn a network round trip before the
 * request even joins the queue. Both converge on `claimAndSaveProfile`.
 */
export type SetupRequest =
  | { source: "params"; params: ImportedProfileParams }
  | { source: "pairingCode"; label: string; code: string };

/** How long `completeProfileSetup` holds the just-verified profile's tailnet
 * join open for the real new owner (`useTailnetSidecarOwner`, mounted once
 * "Continuar" switches the active profile) to reclaim before tearing it
 * down — see `releaseTailnetSidecar`'s own doc for the full reasoning.
 * Generous on purpose: a passive-effect flush plus that hook's own
 * `setTimeout(0)` deferral plus a round-trip to the broker is comfortably
 * under a second in practice, but this only needs to be an upper bound, not
 * a tight one — nothing bad happens if the real reclaim is much faster than
 * this, the sidecar just never gets torn down at all in that case. */
export const HANDOVER_GRACE_MS = 15_000;

interface QueueItem {
  key: string;
  request: SetupRequest;
}

// Dedup guard — reserved at enqueue time, before any network call, so the
// two mounts of a React 18 StrictMode replay (or `getCurrent()` and
// `onOpenUrl` independently delivering the same cold-launch URL) can never
// both start redeeming the same single-use join code. Persisted to
// `localStorage`, not just held in memory: `getCurrent()` (Tauri's
// deep-link plugin) can hand back the *same* launch URL again on a later
// cold start of the app, not only within one run (observed live — the
// setup dialog replayed on a plain app restart for a link that had already
// redeemed successfully) — an in-memory-only Set would forget that and
// redeem the same single-use code a second time. Released only when a
// request ends in `failed/claim` and the user dismisses it (see
// `dismissProfileSetup`) — every other outcome means the code is already
// spent and the profile already exists, so the key stays reserved for
// good; there is nothing useful a second attempt at the same key could do.
const REDEEMED_KEYS_STORAGE_KEY = "anywh:profileSetup:redeemedKeys";

function loadReservedKeys(): Set<string> {
  const raw = localStorage.getItem(REDEEMED_KEYS_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistReservedKeys(): void {
  localStorage.setItem(REDEEMED_KEYS_STORAGE_KEY, JSON.stringify([...reservedKeys]));
}

const reservedKeys = loadReservedKeys();

const queue: QueueItem[] = [];
let current: SetupState | null = null;
let currentKey: string | undefined;
/** Duplicates computed once, at claim time, from the profile list as it
 * stood right before this request's `addProfile` — held here (not on
 * `SetupState`'s `failed` variants) so `retryProfileSetup` can still reach
 * `ready` with the original list even though it never re-runs the claim. */
let activeDuplicates: Profile[] = [];
/** The tailnet-sidecar reference `connectStep` acquired for the profile
 * currently being set up, if any — held at module scope rather than by a
 * hook mounted for the pending profile specifically to avoid resolving the
 * tailnet target twice (see the module's "armadilhas" note in the plan:
 * `resolveTailnetTarget` spends a single-use connect grant per call). */
let heldSidecarProfileId: string | undefined;
let running = false;

const listeners = new Set<() => void>();
let cachedSnapshot: ProfileSetupSnapshot = { state: null, queuedCount: 0 };

function publish(): void {
  cachedSnapshot = { state: current, queuedCount: queue.length };
  for (const listener of listeners) listener();
}

function setCurrent(next: SetupState): void {
  current = next;
  publish();
}

export function getProfileSetupState(): ProfileSetupSnapshot {
  return cachedSnapshot;
}

export function subscribeProfileSetup(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function modeOfRequest(request: SetupRequest): SetupMode {
  if (request.source === "pairingCode") return "tailnet"; // the only mode a typed code can ever resolve to
  return request.params.claimUrl && request.params.joinCode ? "tailnet" : "direct";
}

/** Pure, no network — computable before anything is reserved. A typed code
 * keys off `origin` (not `claimUrl`), because `claimUrl` only exists after
 * `resolvePairingCodeParams` runs discovery, and the reservation has to
 * exist before that request ever fires. `null` for a request that can't
 * possibly redeem to anything (malformed code, or `ImportedProfileParams`
 * with neither shape filled in — `parseImportProfileUrl` never actually
 * produces the latter, this is just defensive). */
function computeKey(request: SetupRequest): string | null {
  if (request.source === "pairingCode") {
    const parsed = parsePairingCode(request.code);
    return parsed ? `pairing:${parsed.origin}|${parsed.joinCode}` : null;
  }
  const { params } = request;
  if (params.claimUrl && params.joinCode) return `tailnet:${params.claimUrl}|${params.joinCode}`;
  if (params.host && params.port) return `direct:${params.host}:${params.port}`;
  return null;
}

async function resolveRequestParams(request: SetupRequest): Promise<ImportedProfileParams> {
  if (request.source === "params") return request.params;
  return resolvePairingCodeParams(request.label, request.code);
}

async function connectStep(profile: Profile, mode: SetupMode): Promise<void> {
  if (mode === "direct") return; // nothing to join — useRelayClient dials host:relayPort straight
  const plan = await resolveTailnetTarget(profile);
  const acquisition = acquireTailnetSidecar(profile, plan.target);
  heldSidecarProfileId = profile.id;
  try {
    await acquisition;
  } catch (err) {
    // `acquireTailnetSidecar` caches this exact rejection on the entry
    // (tailnetSidecar.ts) until released — without this, `retryProfileSetup`
    // would just reattach to the same dead promise forever.
    releaseTailnetSidecar(profile.id);
    heldSidecarProfileId = undefined;
    throw err;
  }
}

async function verifyStep(profile: Profile): Promise<VerifiedInfo> {
  const { host, port, token } = await resolveConnection(profile);
  const sessions = await fetchSessions(host, port, token);
  // Best-effort: an older relay with no /control/profiles route 404s here,
  // and that has nothing to do with whether this profile is reachable —
  // failing setup over it would turn every self-hosted relay predating this
  // route into a broken pairing flow.
  await fetchControlProfiles(host, port, token).catch(() => undefined);
  return { sessionCount: sessions.length };
}

async function runFromConnect(mode: SetupMode, profile: Profile): Promise<void> {
  setCurrent({ status: "connecting", mode, profile });
  try {
    await connectStep(profile, mode);
  } catch (err) {
    console.error("[anywh] profile setup: failed to connect", err);
    setCurrent({ status: "failed", mode, stage: "connect", profile });
    running = false;
    return;
  }

  setCurrent({ status: "verifying", mode, profile });
  try {
    const info = await verifyStep(profile);
    setCurrent({ status: "ready", mode, profile, info, duplicates: activeDuplicates });
  } catch (err) {
    console.error("[anywh] profile setup: failed to verify", err);
    setCurrent({ status: "failed", mode, stage: "verify", profile });
  }
  running = false;
}

async function runItem(item: QueueItem): Promise<void> {
  currentKey = item.key;
  const mode = modeOfRequest(item.request);
  setCurrent({ status: "claiming", mode });

  let profile: Profile;
  try {
    const params = await resolveRequestParams(item.request);
    const result = await claimAndSaveProfile(params);
    profile = result.profile;
    activeDuplicates = result.duplicates;
  } catch (err) {
    console.error("[anywh] profile setup: failed to claim", err);
    setCurrent({ status: "failed", mode, stage: "claim" });
    running = false;
    return;
  }

  await runFromConnect(mode, profile);
}

function pump(): void {
  if (running || current !== null) return;
  const item = queue.shift();
  if (!item) return;
  running = true;
  void runItem(item);
}

/** Returns `false` (nothing enqueued) for a malformed request or one whose
 * dedup key is already reserved — a duplicate deep-link delivery, a typed
 * code already mid-flight, or one that already ran to completion this
 * session. `true` otherwise, whether or not the pipeline starts running
 * immediately (it queues behind whatever's already in flight). */
export function enqueueProfileSetup(request: SetupRequest): boolean {
  const key = computeKey(request);
  if (key === null || reservedKeys.has(key)) return false;
  reservedKeys.add(key);
  persistReservedKeys();
  queue.push({ key, request });
  publish();
  pump();
  return true;
}

/** Re-enters the pipeline at `connectStep` with the already-saved profile
 * from a `failed/connect` or `failed/verify` state — a no-op otherwise
 * (nothing to retry from `claiming`/`connecting`/`verifying`/`ready`, and
 * `failed/claim` has no profile to retry with at all). There is no code
 * path from here back into `claimAndSaveProfile` — the guarantee that a
 * retry never re-spends the join code is structural, not a flag some other
 * change could accidentally flip. */
export function retryProfileSetup(): void {
  if (current === null || current.status !== "failed" || current.stage === "claim") return;
  const { mode, profile } = current;
  running = true;
  void runFromConnect(mode, profile);
}

function finishCurrent(): void {
  // A direct-mode request never spends anything single-use — its key only
  // ever guarded against a doubled delivery of the same link saving the
  // same profile twice while the first copy was still in flight. Keeping it
  // reserved past the end made "remove the profile, add the same machine
  // again" a silent no-op for the rest of this device's life (the key is
  // persisted), which the first-run screen turns from an edge case into a
  // path someone will actually walk. A tailnet key stays reserved for good:
  // that code *was* spent, and a second attempt at it can do nothing useful.
  if (current?.mode === "direct" && currentKey !== undefined) {
    reservedKeys.delete(currentKey);
    persistReservedKeys();
  }
  current = null;
  currentKey = undefined;
  activeDuplicates = [];
  running = false;
  publish();
  // Deferred so Radix has a tick to fully unmount the closing dialog before
  // the next queued request (if any) reopens it — see the plan's note on
  // the pump.
  setTimeout(pump, 0);
}

/** "Continuar para novo perfil" — hands the tailnet join (if any) to the
 * real new owner instead of tearing it down, then advances the queue. */
export function completeProfileSetup(): void {
  if (heldSidecarProfileId !== undefined) {
    releaseTailnetSidecar(heldSidecarProfileId, HANDOVER_GRACE_MS);
    heldSidecarProfileId = undefined;
  }
  finishCurrent();
}

/** Esc / click-outside / "Deixar para depois" / "ir para o perfil
 * existente" — every way of leaving the dialog without switching to the
 * profile it just set up. Releases any held tailnet join immediately (no
 * handover is coming for a profile nobody is about to make active) and, only
 * for a terminal `failed/claim`, frees the dedup key — every other outcome
 * already spent the join code, so the key stays reserved for good. */
export function dismissProfileSetup(): void {
  if (current === null) return;
  if (current.status === "failed" && current.stage === "claim" && currentKey !== undefined) {
    reservedKeys.delete(currentKey);
    persistReservedKeys();
  }
  if (heldSidecarProfileId !== undefined) {
    releaseTailnetSidecar(heldSidecarProfileId, 0);
    heldSidecarProfileId = undefined;
  }
  finishCurrent();
}

export function __resetProfileSetupForTests(): void {
  queue.length = 0;
  reservedKeys.clear();
  persistReservedKeys();
  current = null;
  currentKey = undefined;
  activeDuplicates = [];
  heldSidecarProfileId = undefined;
  running = false;
  cachedSnapshot = { state: null, queuedCount: 0 };
}
