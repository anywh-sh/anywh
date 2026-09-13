import type { RemoteProfile } from "@/lib/relay-types";
import { getCachedSessions } from "@/lib/sessionListCache";

export interface Profile {
  /** Immutable slug — the key of every per-profile storage (tabs, recent
   * folders, settings) and of the host-side artifacts (`<id>.env`,
   * `anywh-relay@<id>`, sessions file). Generated once at creation from the
   * label and never rewritten: renaming a profile must not orphan its
   * settings. */
  id: string;
  /** Free text, user-editable, UI only. */
  label: string;
  host: string;
  relayPort: number;
  /** Index into the profile color palette (index.css), allocated against the
   * whole list at creation time. Absent on profiles created before this
   * field existed — fall back to the position in the list. */
  colorIndex?: number;
  /** Legacy: the theme this profile used back when the choice was made per
   * profile and synced through the host. The app now paints one device-wide
   * theme (`lib/themes.ts`) and never writes this field — it is still read
   * from the host's sync, and exactly once more locally, to adopt whatever
   * was chosen before the upgrade. */
  themeId?: string;
  /** Opaque bearer value sent as a `token` query param on the relay
   * WebSocket URL (see `RelayClient.connect`) — for a host sitting behind a
   * reverse proxy that gates access on a static credential the browser
   * `WebSocket` API can't carry as a header. Never synced from a host's own
   * `/control/profiles` (the host has no notion of it); only ever set
   * locally, e.g. by importing a profile via deep link. */
  connectToken?: string;
  /** Tailnet mode — when all three of these are set, the
   * relay connection is proxied through the tailnet-sidecar instead of
   * dialing `host`/`relayPort` directly: the sidecar joins the tailnet with
   * `tailnetAuthKey`/`tailnetControlUrl` and forwards a local TCP listener
   * to `tailnetTarget` (the relay's address *inside* the tailnet).
   * `host`/`relayPort` on a tailnet profile are only a placeholder until
   * `useRelayClient` replaces them with the sidecar's local address. Never
   * synced from a host's own `/control/profiles` (same reasoning as
   * `connectToken` above) — only ever set locally, e.g. by importing a
   * profile via deep link (F4). Always set together, never partially — see
   * `isTailnetProfile`. */
  tailnetAuthKey?: string;
  tailnetControlUrl?: string;
  /** Static fallback target (F2) — dialed by the sidecar's tailnet-up when
   * there's no broker to ask instead. A brokered profile (`isBrokeredProfile`
   * below) resolves the real target fresh on every connection and ignores
   * this field entirely; it only matters for a manually-configured tailnet
   * profile with no broker at all. */
  tailnetTarget?: string;
  /** The broker contract — a generic
   * `POST <brokerUrl>`, signed with the device identity, that answers with
   * a fresh `{endpoint, token}` before every new connection (never reused,
   * enforced by an anti-replay check server-side). Set together with `brokerNodeId`, e.g. by importing a
   * profile via deep link — see `isBrokeredProfile`. */
  brokerUrl?: string;
  /** The id this device is known as *to the broker* — sent as the
   * `X-Node-Id` header CT-1 defines. Distinct from `Profile.id` above,
   * which is only this local install's UI slug and never leaves the
   * device. */
  brokerNodeId?: string;
  /** Where to report the tsnet node key this device earns on its next
   * tailnet join — an opaque URL, resolved
   * server-side (`POST /v1/nodes/claim`'s `reportUrl`) for the same reason
   * `brokerUrl` is opaque: this client never learns the control plane's own
   * route shape. Set together with `brokerNodeId`/`brokerUrl` by a deep-link
   * import; absent for a manually configured tailnet profile, which has no
   * control plane to report to. */
  tailnetReportUrl?: string;
  /** Saved but never proven reachable. Set by `claimAndSaveProfile` — a
   * profile is written before it is verified — and cleared the first time
   * a whole `/sessions` list comes back for it: the setup pipeline's own
   * verification, or the shell's session sync later (`markProfileVerified`).
   * Survives the host sync's field-by-field merge on purpose
   * (`syncProfilesForHost`), which would otherwise erase it within 30 s.
   * Read by `App`'s gate (a sole unverified profile resumes its setup on
   * launch) and by the badge. */
  unverified?: boolean;
  /** Created by the in-app install on this very machine, so its `host` is
   * whatever address the installer bound — often loopback, sometimes a LAN
   * or tailnet address that only makes sense from here. Exempt from
   * `syncProfilesForHost`'s loopback cleanup, which would otherwise drop it
   * the first time a sync against a *remote* host succeeds, and inherited
   * across that sync's merge like the other local-only fields. */
  localRelay?: boolean;
}

/** A profile is in tailnet mode iff it can join the tailnet
 * (`tailnetAuthKey` + `tailnetControlUrl`) and has some way to know what to
 * dial once joined — either a static `tailnetTarget` (F2) or a broker to
 * ask fresh each time (F3, see `isBrokeredProfile`). `useRelayClient` and
 * `tailnetSidecar.ts` both branch on this instead of checking the fields
 * individually, so the invariant only needs to be enforced in one place. */
export function isTailnetProfile(profile: Profile): boolean {
  const canJoin = Boolean(profile.tailnetAuthKey && profile.tailnetControlUrl);
  return canJoin && Boolean(profile.tailnetTarget || isBrokeredProfile(profile));
}

/** A profile can call the broker iff both halves of
 * the contract are set together — the URL to call and the id this device
 * is known as there. Never partially, same "all or nothing" reasoning as
 * `isTailnetProfile`. */
export function isBrokeredProfile(profile: Profile): boolean {
  return Boolean(profile.brokerUrl && profile.brokerNodeId);
}

const STORAGE_KEY = "anywh:profiles";

/** Where `useActiveProfile` remembers which profile was in front last. Not
 * private to that hook because the first-run flow has to write it before
 * the shell ever mounts (`finishFirstRun`) — the hook's initial read is the
 * only moment the value is consulted, and by then it has to be there. */
export const LAST_PROFILE_STORAGE_KEY = "anywh:last-profile";

function isProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.relayPort === "number"
  );
}

/**
 * What is on disk, or `[]`. No seed: a device with nothing stored has no
 * profile, and the app shows its first-run screen instead of pretending a
 * relay is listening on loopback. Unreadable storage (a half-written or
 * hand-edited entry) also reads as empty — but the key is left exactly as
 * it was, never overwritten with `[]`: whatever is in there may still be
 * recoverable by hand, and the first write that does happen (a profile
 * added from the first-run screen) replaces it anyway.
 */
function readStoredProfiles(): Profile[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isProfile) ? parsed : [];
  } catch {
    return [];
  }
}

// A profile can only ever legitimately report one of these as its own
// `RELAY_HOST` if the device syncing it is on the very same machine —
// loopback is unreachable from anywhere else. `ensureSelfRegistered`
// (relay/src/profileRegistry.ts) falls back to `127.0.0.1` for exactly this
// reason when it self-registers a `"default"` profile, so any locally
// stored entry still carrying one of these hosts is either that ghost or
// equally unreachable junk — safe to drop the moment a sync against a real
// (non-loopback) host succeeds, even if the id no longer shows up in that
// sync's response at all (the id-based cleanup below only catches a ghost
// that's still being re-registered under a *different* port each time; one
// that stopped existing entirely — e.g. its `.env` got deleted — needs this
// instead). A tailnet profile is the one exception — its loopback host is
// the `importProfile` placeholder, swapped for the
// sidecar's real local address by `useRelayClient` before anything is
// dialed, so it looks identical to a ghost while actually being a live
// profile whose auth key/broker config exists nowhere else (no host's
// `/control/profiles` can hand it back).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const GHOST_MIGRATION_KEY = "anywh:migrations:drop-loopback-default";

/**
 * One-shot cleanup of the seed this module used to plant. Every install
 * before the first-run screen existed started with a `"default"` profile
 * pointing at `127.0.0.1:8765`, whether or not anything listened there; on
 * a device that never had a relay, that ghost is what would stand between
 * the upgrade and the first-run screen. Dropped only when all four hold: it
 * is the *only* entry, it has the seed's id, its host is loopback, and this
 * device never once synced a session list for it (`syncedAt === null`).
 * Each condition guards a real person — someone who runs a relay on
 * loopback for real has synced it, someone who renamed the seed has a
 * different id, someone with a second profile has already been through
 * pairing. Flagged so it runs once per device: a loopback profile called
 * "default" created later, on purpose, is never touched.
 */
function dropSeededGhost(list: Profile[]): Profile[] {
  if (localStorage.getItem(GHOST_MIGRATION_KEY) !== null) return list;
  localStorage.setItem(GHOST_MIGRATION_KEY, "1");
  const [only] = list;
  const isGhost =
    list.length === 1 &&
    only.id === "default" &&
    LOOPBACK_HOSTS.has(only.host) &&
    getCachedSessions("default").syncedAt === null;
  if (!isGhost) return list;
  localStorage.setItem(STORAGE_KEY, "[]");
  return [];
}

let profiles: Profile[] = dropSeededGhost(readStoredProfiles());
const listeners = new Set<() => void>();

/** Synchronous read of the current list — for call sites that aren't React
 * components (event handlers, one-off migrations) and don't need to
 * re-render when it changes. Components that render the list itself should
 * use `useProfiles` (hooks/useProfiles.ts) instead. */
export function getProfiles(): Profile[] {
  return profiles;
}

/** Replaces the whole list and persists it — the write side of the store;
 * `addProfile`, `removeProfile` and `syncProfilesForHost` all go through
 * here. An empty `next` is allowed: see `removeProfile`. */
export function setProfiles(next: Profile[]): void {
  profiles = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

export function subscribeProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function findProfile(id: string): Profile | undefined {
  return profiles.find((profile) => profile.id === id);
}

/** Appends a profile, or replaces the entry with the same id (the host
 * registry is authoritative for label/color, so re-adding is an update). */
export function addProfile(profile: Profile): void {
  setProfiles([...profiles.filter((p) => p.id !== profile.id), profile]);
}

/** Removes a profile — the last one included. An empty list is a
 * legitimate state (it is what puts the first-run screen on the window), so
 * nothing here refuses; the surfaces that offer removal say what removing
 * the only profile means instead (`RevokedProfileBanner`, `DangerZone`).
 * Returns whether anything was actually removed. */
/** The profile answered: a whole session list came back for it. Clears
 * `unverified`, persisting the change; a no-op (same array, same objects)
 * when the flag isn't set, so the hot path — every session sync — never
 * writes. */
export function markProfileVerified(id: string): void {
  const profile = profiles.find((p) => p.id === id);
  if (!profile?.unverified) return;
  const verified: Profile = { ...profile };
  delete verified.unverified;
  setProfiles(profiles.map((p) => (p.id === id ? verified : p)));
}

export function removeProfile(id: string): boolean {
  if (!profiles.some((p) => p.id === id)) return false;
  setProfiles(profiles.filter((p) => p.id !== id));
  return true;
}

function profileFieldsEqual(a: Profile, b: Profile): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.host === b.host &&
    a.relayPort === b.relayPort &&
    a.colorIndex === b.colorIndex &&
    a.themeId === b.themeId &&
    a.connectToken === b.connectToken &&
    a.tailnetAuthKey === b.tailnetAuthKey &&
    a.tailnetControlUrl === b.tailnetControlUrl &&
    a.tailnetTarget === b.tailnetTarget &&
    a.brokerUrl === b.brokerUrl &&
    a.brokerNodeId === b.brokerNodeId &&
    a.tailnetReportUrl === b.tailnetReportUrl &&
    a.unverified === b.unverified &&
    a.localRelay === b.localRelay
  );
}

/** Order-insensitive comparison — `merged` below (`syncProfilesForHost`) can
 * reorder entries (the remote-host slice is always appended last) even when
 * nothing actually changed, so a positional comparison would false-positive
 * on every sync. */
function profileListsEqual(a: Profile[], b: Profile[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((p) => [p.id, p]));
  return b.every((p) => {
    const existing = byId.get(p.id);
    return existing !== undefined && profileFieldsEqual(existing, p);
  });
}

/** Mirrors `host`'s `GET /control/profiles` onto the local list — the only
 * write path now that profiles are auto-synced instead of manually
 * imported (see `useProfileSync`). Replaces entries for `host`, plus any
 * local entry whose `id` also appears in `remote` regardless of the host it
 * was previously stored under — a profile's own advertised `host` (each
 * entry's `RELAY_HOST`, read server-side) can legitimately differ from the
 * host this device dialed to reach it (e.g. an `ensureSelfRegistered`
 * `"default"` self-registration reports `127.0.0.1` while the machine's
 * real profiles report a Tailscale IP). Deduping only by host let a stale
 * `"default"` row survive every sync against a differently-hosted profile,
 * and a fresh one from `remote` got appended alongside it each time —
 * duplicate rows for the same id piling up in the switcher. Also drops any
 * locally stored loopback-hosted entry once a sync against a real host
 * succeeds, even one whose id disappeared from the registry entirely (see
 * `LOOPBACK_HOSTS`). A device can still know profiles from more than one
 * real host at once (`DangerZone`'s executor lookup already assumes this).
 * Guards against ever emptying the list — unlike `removeProfile`, which
 * may: an empty list by local decision is legitimate, an empty list handed
 * back by a host is data loss (a transient empty response shouldn't wipe
 * out every profile this device knows about). */
export function syncProfilesForHost(host: string, remote: RemoteProfile[]): void {
  const remoteIds = new Set(remote.map((entry) => entry.id));
  const keepForHost = LOOPBACK_HOSTS.has(host)
    ? (p: Profile) => p.host !== host && !remoteIds.has(p.id)
    : (p: Profile) => p.host !== host && !remoteIds.has(p.id) && !LOOPBACK_HOSTS.has(p.host);
  // A tailnet profile is never dropped by any of the host-based reasoning
  // above: its `host` is the sidecar placeholder, not a relay it was synced
  // from, so no registry response either replaces it or proves it stale.
  // A profile the in-app install created on this machine is kept the same
  // way: its loopback host is legitimate here, and no other host's registry
  // can vouch for it.
  const dropStale = (p: Profile) => (isTailnetProfile(p) || p.localRelay ? !remoteIds.has(p.id) : keepForHost(p));
  // `connectToken`/tailnet fields have no host-side counterpart (the control
  // API response never carries them), so a synced entry has to inherit
  // whatever this device already had for that id — otherwise a profile
  // imported via deep link would lose its token/tailnet config the moment
  // its host's `/control/profiles` also happens to report the same id.
  const existingById = new Map(profiles.map((p) => [p.id, p]));
  const merged = [
    ...profiles.filter(dropStale),
    ...remote.map((entry) => {
      const existing = existingById.get(entry.id);
      return {
        id: entry.id,
        label: entry.label,
        host: entry.host,
        relayPort: entry.port,
        colorIndex: entry.colorIndex,
        themeId: entry.themeId,
        connectToken: existing?.connectToken,
        tailnetAuthKey: existing?.tailnetAuthKey,
        tailnetControlUrl: existing?.tailnetControlUrl,
        tailnetTarget: existing?.tailnetTarget,
        brokerUrl: existing?.brokerUrl,
        brokerNodeId: existing?.brokerNodeId,
        tailnetReportUrl: existing?.tailnetReportUrl,
        // Inherited, not cleared: this response came through *another*
        // profile's connection and says nothing about whether this one
        // answers. Only a fetch against the profile itself clears it.
        unverified: existing?.unverified,
        localRelay: existing?.localRelay,
      };
    }),
  ];
  if (merged.length === 0) return;
  // Every sync builds a brand-new array/objects regardless of whether the
  // host actually reported anything different — without this check,
  // `setProfiles` would hand every consumer a fresh `Profile` reference on
  // each poll (`useForegroundSync`, every 30s or on window focus), and
  // anything keyed on that reference (e.g. `FileViewer`'s fetch effect)
  // would re-run and flash even though nothing changed.
  if (profileListsEqual(profiles, merged)) return;
  setProfiles(merged);
}

const PROFILE_COLOR_CLASSES = [
  "bg-profile-1", "bg-profile-2", "bg-profile-3",
  "bg-profile-4", "bg-profile-5", "bg-profile-6",
];

/** Size of the palette — for a color picker (`SettingsDialog`) to iterate
 * over every swatch without duplicating the count. */
export const PROFILE_COLOR_COUNT = PROFILE_COLOR_CLASSES.length;

/** Raw index → color class — the color picker in `SettingsDialog` renders
 * every swatch by index directly, without going through a `Profile` at all. */
export function profileColorClassForIndex(index: number): string {
  return PROFILE_COLOR_CLASSES[index % PROFILE_COLOR_CLASSES.length];
}

/** Stable color for a profile's dot. Reads the index allocated at creation
 * time; falls back to the position in the list for profiles stored before
 * `colorIndex` existed (the two seeded ones keep their current colors that
 * way, since `pessoal` is first and `trabalho` second). */
export function profileColorClass(profileId: string): string {
  return profileColorClassForIndex(profileColorIndex(profileId));
}

/** Raw `var(--profile-N)` reference, for a caller that needs the color as an
 * inline style (the session list's live spinner paints just its top border
 * this way, matching the design) rather than as a Tailwind background/text
 * class. */
export function profileColorVar(profileId: string): string {
  return `var(--profile-${(profileColorIndex(profileId) % PROFILE_COLOR_CLASSES.length) + 1})`;
}

// Opaque cousins of `PROFILE_COLOR_CLASSES` (index.css's `--profile-N-soft`/
// `--profile-N-faint`, mixed toward a fixed literal rather than
// `transparent`) — a tab always washes its own background in its profile's
// color, faint at rest and brighter once selected, so a glance at the strip
// says which session belongs to which profile without waiting for it to
// become active. Deliberately not the `/N` opacity modifier: that composites
// with whatever's actually behind the element, which on this dark theme read
// as a near-black smudge instead of a soft version of the color. Written out
// as literal class names (not built with a template string) because
// Tailwind's scanner needs the full utility name present verbatim in
// source to generate it.
const PROFILE_FAINT_BG_CLASSES = [
  "bg-profile-1-faint",
  "bg-profile-2-faint",
  "bg-profile-3-faint",
  "bg-profile-4-faint",
  "bg-profile-5-faint",
  "bg-profile-6-faint",
];

const PROFILE_ACTIVE_BG_CLASSES = [
  "data-[state=active]:bg-profile-1-soft",
  "data-[state=active]:bg-profile-2-soft",
  "data-[state=active]:bg-profile-3-soft",
  "data-[state=active]:bg-profile-4-soft",
  "data-[state=active]:bg-profile-5-soft",
  "data-[state=active]:bg-profile-6-soft",
];

// Same `-soft` tint as the active tab state above, reused as the tab's
// close button's own hover — a variation of the tab's own background rather
// than the generic neutral `surface-hover` every other hover in the shell
// uses. The tab itself no longer changes background on hover at all (only
// the close button does), so this is the one hover cue the tab row still
// gives.
const PROFILE_CLOSE_HOVER_CLASSES = [
  "hover:bg-profile-1-soft",
  "hover:bg-profile-2-soft",
  "hover:bg-profile-3-soft",
  "hover:bg-profile-4-soft",
  "hover:bg-profile-5-soft",
  "hover:bg-profile-6-soft",
];

// The selected tab's underline — an `inset` shadow rather than a border or an
// extra element, so it doesn't shift the tab's box or its content by a pixel
// when it turns on. Toggled purely by the `data-state` attribute (no
// transition on `box-shadow`, which has no compositor fast path).
const PROFILE_ACTIVE_UNDERLINE_CLASSES = [
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--profile-1)]",
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--profile-2)]",
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--profile-3)]",
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--profile-4)]",
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--profile-5)]",
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--profile-6)]",
];

function profileColorIndex(profileId: string): number {
  const index = profiles.findIndex((p) => p.id === profileId);
  const profile = index >= 0 ? profiles[index] : undefined;
  return profile?.colorIndex ?? (index >= 0 ? index : 0);
}

/** A tab's full profile treatment: faint tint at rest, brighter tint plus a
 * bottom-edge underline once selected — same color/index rules as
 * `profileColorClass`, just mapped onto the palettes above. */
export function profileTabClasses(profileId: string): string {
  const index = profileColorIndex(profileId) % PROFILE_COLOR_CLASSES.length;
  return `${PROFILE_FAINT_BG_CLASSES[index]} ${PROFILE_ACTIVE_BG_CLASSES[index]} ${PROFILE_ACTIVE_UNDERLINE_CLASSES[index]}`;
}

/** The tab's own `-soft` tint, as a hover class for its close button — see
 * `PROFILE_CLOSE_HOVER_CLASSES`. */
export function profileCloseHoverClass(profileId: string): string {
  const index = profileColorIndex(profileId) % PROFILE_COLOR_CLASSES.length;
  return PROFILE_CLOSE_HOVER_CLASSES[index];
}
