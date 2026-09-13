import { claimAndSaveProfile, resolvePairingCodeParams, type ImportedProfileParams } from "@/lib/profileImport";
import { parsePairingCode } from "@/lib/pairingCode";
import { resolveConnection } from "@/lib/connectionResolver";
import { resolveTailnetTarget } from "@/lib/tailnetBroker";
import { acquireTailnetSidecar, releaseTailnetSidecar } from "@/lib/tailnetSidecar";
import { fetchControlProfiles, fetchSessions } from "@/lib/relayClient";
import { findProfile, isTailnetProfile, markProfileVerified, type Profile } from "@/lib/profiles";

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
  /** `holdProfileSetup` is in effect: whatever is queued waits for the
   * release, and the UI says so instead of looking stuck. */
  held: boolean;
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

/**
 * Dedup guard, in two stages.
 *
 * `reserved` — taken at enqueue time, before any network call, and held in
 * memory only. It exists so the two mounts of a React 18 StrictMode replay
 * (or `getCurrent()` and `onOpenUrl` independently delivering the same
 * cold-launch URL) can never both start redeeming the same single-use join
 * code. Released when its request settles, whatever the outcome.
 * Deliberately not persisted: a reservation is by construction pre-network,
 * so one left over from a run that died before the claim describes nothing
 * that happened — persisting it (the previous design) turned every link the
 * app was killed on into a link that could never be redeemed again, with
 * no error to say so.
 *
 * `spent` — set immediately before `claimAndSaveProfile` for a request
 * about to consume its code, and persisted: `getCurrent()` (Tauri's
 * deep-link plugin) can hand back the *same* launch URL again on a later
 * cold start (observed live — the setup dialog replayed on a plain restart
 * for a link that had already redeemed), and an in-memory set would forget
 * that and redeem the same code a second time. Marked before the call, not
 * after: a death in between would otherwise leave a redeemed code looking
 * fresh. Never before `resolveRequestParams` — discovering a typed code's
 * endpoints consumes nothing. Direct-mode requests never spend anything
 * (reaching a host:port consumes nothing) and are only ever reserved. A
 * claim that fails and is dismissed unspends its key: whether the server
 * consumed the code is the server's call, made on the next attempt, not
 * this device's guess.
 *
 * Written in two formats for one release: the new `{version, spent}` object
 * under `SETUP_KEYS_STORAGE_KEY`, and the old flat array under
 * `LEGACY_REDEEMED_KEYS_STORAGE_KEY`, which a downgraded build still reads —
 * its `Array.isArray` check would otherwise fail on the new shape and forget
 * every spent code, exactly the condition the guard exists for.
 */
const SETUP_KEYS_STORAGE_KEY = "anywh:profileSetup:keys";
const LEGACY_REDEEMED_KEYS_STORAGE_KEY = "anywh:profileSetup:redeemedKeys";

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function loadSpentKeys(): Set<string> {
  const raw = localStorage.getItem(SETUP_KEYS_STORAGE_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) return new Set(stringsOf((parsed as { spent?: unknown }).spent));
    } catch {
      // Unreadable — fall through to the legacy key rather than to nothing.
    }
  }
  // Upgrading from the flat array: every key there was held "for good",
  // which is what spent means now. The pre-network reservations it also
  // carried can't be told apart and stay spent — the one-time cost of the
  // migration, paid only by links that had already died silently.
  const legacy = localStorage.getItem(LEGACY_REDEEMED_KEYS_STORAGE_KEY);
  if (!legacy) return new Set();
  try {
    return new Set(stringsOf(JSON.parse(legacy)));
  } catch {
    return new Set();
  }
}

function persistSpentKeys(): void {
  const list = [...spentKeys];
  localStorage.setItem(SETUP_KEYS_STORAGE_KEY, JSON.stringify({ version: 2, spent: list }));
  localStorage.setItem(LEGACY_REDEEMED_KEYS_STORAGE_KEY, JSON.stringify(list));
}

const spentKeys = loadSpentKeys();
const reservedKeys = new Set<string>();

const queue: QueueItem[] = [];
let current: SetupState | null = null;
let currentKey: string | undefined;
/**
 * Bumped by `dismissProfileSetup` whenever it interrupts a request that is
 * still running (`claiming`/`connecting`/`verifying`). Every run captures
 * the value in effect when it started; an intermediate `setCurrent`
 * ("connecting", "verifying") is simply skipped on a mismatch, and a
 * terminal one (`settleTerminal`) releases the run's bookkeeping instead of
 * publishing the dialog back onto the screen — see that function's doc for
 * why the release can't happen any earlier than this.
 *
 * This is the only thing "cancel" buys here: the pipeline itself (network
 * calls, `claimAndSaveProfile`'s single-use bookkeeping, the tailnet
 * acquisition held in `heldSidecarProfileId`) keeps running to whatever
 * outcome it was already headed for. Actually aborting it would either risk
 * burning a single-use join code mid-redeem or tear down a sidecar
 * acquisition another call is still awaiting — both worse than a request
 * nobody's watching finishing quietly. The profile it was working on
 * converges to `verified` or stays `unverified` on disk either way, and the
 * `soleUnverified`/badge-in-the-switcher paths already know what to do with
 * that.
 */
let generation = 0;
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
/** See `holdProfileSetup`. */
let held = false;

const listeners = new Set<() => void>();
let cachedSnapshot: ProfileSetupSnapshot = { state: null, queuedCount: 0, held: false };

function publish(): void {
  cachedSnapshot = { state: current, queuedCount: queue.length, held };
  for (const listener of listeners) listener();
}

function setCurrent(next: SetupState): void {
  current = next;
  publish();
}

/**
 * The end of a run, reached whether or not anyone dismissed it along the
 * way. If `gen` still matches `generation`, nobody did — show the outcome
 * normally. Otherwise `dismissProfileSetup` hid the dialog for this run
 * already and deliberately left `running`, `currentKey`'s reservation, and
 * `activeDuplicates` untouched so the run itself could release them here,
 * at its own true end, instead of the moment it was dismissed — freeing
 * them early would have let a second request for the same key (a retyped
 * host:port, a re-delivered deep link) start racing this orphaned one over
 * the same module state (`heldSidecarProfileId` in particular). Skipping
 * this — i.e. only ever hiding the dialog on dismiss and never reaching
 * back to release the reservation — is exactly what left "that machine is
 * already being set up" stuck forever the first time this shipped.
 */
function settleTerminal(gen: number, state: SetupState): void {
  running = false;
  if (gen === generation) {
    setCurrent(state);
    return;
  }
  // Mirrors the terminal branch of `dismissProfileSetup`: a claim that
  // turns out to have failed only after the dialog for it was already
  // dismissed still gets its key unspent, the same as one that failed
  // while someone was watching.
  if (state.status === "failed" && state.stage === "claim" && currentKey !== undefined) {
    spentKeys.delete(currentKey);
    persistSpentKeys();
  }
  finishCurrent();
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

async function runFromConnect(mode: SetupMode, profile: Profile, gen: number): Promise<void> {
  if (gen === generation) setCurrent({ status: "connecting", mode, profile });
  try {
    await connectStep(profile, mode);
  } catch (err) {
    console.error("[anywh] profile setup: failed to connect", err);
    settleTerminal(gen, { status: "failed", mode, stage: "connect", profile });
    return;
  }

  if (gen === generation) setCurrent({ status: "verifying", mode, profile });
  try {
    const info = await verifyStep(profile);
    // The store's copy is the one with `unverified` cleared — the dialog
    // and whoever adopts the profile from `ready` should see that one.
    markProfileVerified(profile.id);
    settleTerminal(gen, { status: "ready", mode, profile: findProfile(profile.id) ?? profile, info, duplicates: activeDuplicates });
  } catch (err) {
    console.error("[anywh] profile setup: failed to verify", err);
    settleTerminal(gen, { status: "failed", mode, stage: "verify", profile });
  }
}

async function runItem(item: QueueItem): Promise<void> {
  currentKey = item.key;
  const gen = generation;
  const mode = modeOfRequest(item.request);
  setCurrent({ status: "claiming", mode });

  let profile: Profile;
  try {
    const params = await resolveRequestParams(item.request);
    if (mode === "tailnet") {
      spentKeys.add(item.key);
      persistSpentKeys();
    }
    const result = await claimAndSaveProfile(params);
    profile = result.profile;
    activeDuplicates = result.duplicates;
  } catch (err) {
    console.error("[anywh] profile setup: failed to claim", err);
    settleTerminal(gen, { status: "failed", mode, stage: "claim" });
    return;
  }

  await runFromConnect(mode, profile, gen);
}

function pump(): void {
  if (running || current !== null || held) return;
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
  if (key === null || reservedKeys.has(key) || spentKeys.has(key)) return false;
  reservedKeys.add(key);
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
  void runFromConnect(mode, profile, generation);
}

/** Re-enters the pipeline at `connectStep` for a profile an earlier run
 * saved but never brought to `ready` — the app was closed between the claim
 * and the verification, or the verification failed and was left for later
 * — which is what `Profile.unverified` marks. The sibling of
 * `retryProfileSetup`, with the same structural guarantee: there is no path
 * from here back into `claimAndSaveProfile`. A no-op while another request
 * is in flight (the caller reads the same snapshot and can see that). */
export function resumeProfileSetup(profile: Profile): void {
  if (running || current !== null) return;
  currentKey = undefined;
  activeDuplicates = [];
  running = true;
  void runFromConnect(isTailnetProfile(profile) ? "tailnet" : "direct", profile, generation);
}

/**
 * Keeps the queue from starting its next request. A link that arrives
 * while something else owns the screen (a local relay install mid-flight)
 * is still enqueued and still reserved — it just waits, visibly (`held`
 * on the snapshot), until the caller lets go. Holding never interrupts a
 * request already in flight. Returns the release, which the caller must
 * invoke from a `finally`: a hold that is never released is the most
 * likely new way for a link to die silently. Idempotent to release twice.
 */
export function holdProfileSetup(): () => void {
  held = true;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held = false;
    publish();
    pump();
  };
}

/** Throws away everything *waiting* in the queue — never the request in
 * flight — and frees their reservations, so the same links can be enqueued
 * again later. The "discard" on a link shown as waiting. */
export function dropQueuedProfileSetup(): void {
  for (const item of queue) reservedKeys.delete(item.key);
  queue.length = 0;
  publish();
}

function finishCurrent(): void {
  // The reservation's job is done either way; what outlives the request is
  // the `spent` mark, if this one earned it.
  if (currentKey !== undefined) reservedKeys.delete(currentKey);
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

function isInFlight(state: SetupState): boolean {
  return state.status === "claiming" || state.status === "connecting" || state.status === "verifying";
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
 * for a terminal `failed/claim`, unspends the key — whether the server
 * consumed the code is its call on the next attempt. Every other outcome
 * did redeem it, and the mark stays.
 *
 * A request still running (`claiming`/`connecting`/`verifying`) only has its
 * dialog hidden, not its bookkeeping torn down: `running` (and, for a claim,
 * the reservation) stay exactly as they are, so `pump`/`resumeProfileSetup`
 * keep treating one as in flight until the orphaned continuation reaches its
 * own natural end and clears them itself — freeing them here instead would
 * let a second request for the same profile start racing the first one
 * over shared module state (`heldSidecarProfileId` in particular). Bumping
 * `generation` is what keeps that continuation from reopening the dialog
 * when it eventually does settle — see its doc comment. */
export function dismissProfileSetup(): void {
  if (current === null) return;
  if (current.status === "failed" && current.stage === "claim" && currentKey !== undefined) {
    spentKeys.delete(currentKey);
    persistSpentKeys();
  }
  if (heldSidecarProfileId !== undefined) {
    releaseTailnetSidecar(heldSidecarProfileId, 0);
    heldSidecarProfileId = undefined;
  }
  if (isInFlight(current)) {
    generation++;
    current = null;
    publish();
    return;
  }
  finishCurrent();
}

export function __resetProfileSetupForTests(): void {
  queue.length = 0;
  reservedKeys.clear();
  spentKeys.clear();
  persistSpentKeys();
  current = null;
  currentKey = undefined;
  activeDuplicates = [];
  heldSidecarProfileId = undefined;
  running = false;
  held = false;
  generation = 0;
  cachedSnapshot = { state: null, queuedCount: 0, held: false };
}
