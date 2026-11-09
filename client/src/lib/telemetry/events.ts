/**
 * The only events the app may send, and the exact shape of each.
 *
 * A registry rather than a free-form `track(name, props)`: an event that is
 * not listed here is dropped, and so is one whose properties are not exactly
 * the listed keys with values the listed type accepts. That is what makes
 * "no prompt, path, file name or error text ever leaves the app" a property
 * of the code and not of every call site's good behaviour — a string can only
 * get out as a member of a closed list, or as a short value matching a
 * pattern (a version number). Nothing here accepts free text.
 */

type PropSpec =
  | { kind: "bool" }
  /** A whole number in `0..max`. */
  | { kind: "count"; max: number }
  /** One of a closed list. */
  | { kind: "enum"; values: readonly string[] }
  /** A short list of members of a closed list (each at most once). */
  | { kind: "enumList"; values: readonly string[]; maxItems: number }
  /** A short string that has to match, for the one value that cannot be a
   * closed list (a version number). */
  | { kind: "pattern"; pattern: RegExp; maxLength: number };

interface PropField {
  spec: PropSpec;
  /** Absent from the payload is fine; present has to validate. */
  optional?: boolean;
}

const bool = { spec: { kind: "bool" } } as const;
const count = (max = 1000) => ({ spec: { kind: "count", max } }) as const;
const oneOf = <const V extends readonly string[]>(values: V) => ({ spec: { kind: "enum", values } }) as const;
const optionalOneOf = <const V extends readonly string[]>(values: V) => ({ spec: { kind: "enum", values }, optional: true }) as const;
const listOf = <const V extends readonly string[]>(values: V, maxItems: number) => ({ spec: { kind: "enumList", values, maxItems } }) as const;
const version = { spec: { kind: "pattern", pattern: /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,24})?$/, maxLength: 40 } } as const;

export const FEATURES = [
  "sala",
  "terminal",
  "files_panel",
  "file_viewer",
  "voice",
  "attachment",
  "split_tab",
  "global_search",
  "integration_jira",
  "mcp_signin",
  "slash_command",
  "theme_import",
  "plan_usage_refresh",
  "open_in_editor",
  "background_jobs",
] as const;
export type Feature = (typeof FEATURES)[number];

export const ERROR_KINDS = [
  "agent_install_failed",
  "relay_install_failed",
  "relay_version_mismatch",
  "relay_unreachable",
  "profile_revoked",
  "mcp_signin_failed",
  "update_failed",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const RUNTIMES = ["claude", "codex", "other"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** What a runtime id, model id, effort or permission mode reduces to before
 * it is sent. Every list ends in `other`: an agent this build has never
 * heard of is counted, never named. */
export const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "gpt", "other"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "other"] as const;
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "read-only", "workspace-write", "full-access", "other"] as const;
const UPDATE_MODES = ["notify", "auto-download", "off"] as const;
const FIRST_RUN_SCREENS = ["welcome", "preparing", "agents", "other", "advanced"] as const;
const FIRST_RUN_MODES = ["install", "adopt", "code", "address", "app", "terminal"] as const;
const FIRST_RUN_PATHS = ["local_install", "adopt", "remote"] as const;
const AGENT_IDS = ["claude", "codex"] as const;

/** The failed stages of the profile-setup pipeline. */
export const CONNECT_FAILED_STAGES = ["claim", "connect", "verify"] as const;
export type ConnectFailedStage = (typeof CONNECT_FAILED_STAGES)[number];
/** Only what the error itself tells: a browser fetch that got no answer is
 * `unreachable`, never `refused` — see `connectFailureReasonOf`. */
export const CONNECT_FAILURE_REASONS = ["refused", "timeout", "unreachable", "auth", "other"] as const;
export type ConnectFailureReason = (typeof CONNECT_FAILURE_REASONS)[number];
/** The kind of address dialled, never the address. */
export const ADDRESS_CLASSES = ["loopback", "private_lan", "tailscale", "public", "hostname", "brokered"] as const;
export type AddressClass = (typeof ADDRESS_CLASSES)[number];

function closed<T extends readonly string[]>(values: T, pick: string | null | undefined): T[number] | "other" {
  return pick !== null && pick !== undefined && (values as readonly string[]).includes(pick) ? pick : "other";
}

/** `claude-opus-4-5`, `opusplan`, `gpt-5-codex`… to a family. Matches on the
 * id's own text and answers `other` when it does not recognise it, so a
 * model nobody heard of yet is a count under `other`, not a string. */
export function modelFamily(modelId: string | null | undefined): ModelFamily {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  if (id.startsWith("gpt") || id.includes("codex")) return "gpt";
  return "other";
}

export function runtimeOf(agentId: string | null | undefined): Runtime {
  return closed(["claude", "codex"] as const, agentId);
}

export function effortOf(effort: string | null | undefined): (typeof EFFORTS)[number] {
  return effort === null || effort === undefined ? "none" : closed(EFFORTS, effort);
}

export function permissionModeOf(mode: string | null | undefined): (typeof PERMISSION_MODES)[number] {
  return closed(PERMISSION_MODES, mode);
}

export function updateModeOf(mode: string | null | undefined): (typeof UPDATE_MODES)[number] {
  return closed(UPDATE_MODES, mode) as (typeof UPDATE_MODES)[number];
}

export function agentIdOf(id: string): (typeof AGENT_IDS)[number] | null {
  return (AGENT_IDS as readonly string[]).includes(id) ? (id as (typeof AGENT_IDS)[number]) : null;
}

interface EventDef<F extends Record<string, PropField> = Record<string, PropField>> {
  fields: F;
  /** Most sends allowed in any 60s window. A bug that fires an event in a
   * loop must cost the quota of one event, not of a feed. */
  perMinute: number;
}

const def = <const F extends Record<string, PropField>>(fields: F, perMinute = 10): EventDef<F> => ({ fields, perMinute });

export const EVENTS = {
  app_opened: def({
    profile_count: count(100),
    local_profiles: count(100),
    remote_profiles: count(100),
    runtimes_installed: listOf(AGENT_IDS, 4),
    update_mode: oneOf(UPDATE_MODES),
    push_enabled: bool,
    theme_kind: oneOf(["builtin", "custom"]),
    font_size_bucket: oneOf(["small", "default", "large"]),
  }, 3),
  app_active: def({}, 3),
  first_run_step_viewed: def({ step: oneOf(FIRST_RUN_SCREENS), mode: optionalOneOf(FIRST_RUN_MODES) }, 30),
  first_run_completed: def({
    path: oneOf(FIRST_RUN_PATHS),
    duration_s: count(7 * 24 * 3600),
    agents_installed: listOf(AGENT_IDS, 4),
  }, 3),
  first_prompt_sent: def({ seconds_since_first_open: count(365 * 24 * 3600), runtime: oneOf(RUNTIMES) }, 3),
  session_started: def({
    runtime: oneOf(RUNTIMES),
    model_family: oneOf(MODEL_FAMILIES),
    effort: oneOf(EFFORTS),
    permission_mode: oneOf(PERMISSION_MODES),
    kind: oneOf(["chat", "sala"]),
  }, 30),
  feature_used: def({ feature: oneOf(FEATURES) }, 20),
  profile_added: def({ kind: oneOf(["local", "remote"]), pairing_method: optionalOneOf(["code", "address"]) }, 10),
  profile_connect_failed: def({
    stage: oneOf(CONNECT_FAILED_STAGES),
    reason: oneOf(CONNECT_FAILURE_REASONS),
    address_class: oneOf(ADDRESS_CLASSES),
    in_first_run: bool,
  }, 10),
  error_shown: def({ kind: oneOf(ERROR_KINDS) }, 10),
  update_installed: def({ from_version: version, to_version: version, update_mode: oneOf(UPDATE_MODES) }, 3),
  telemetry_opted_out: def({ source: oneOf(["banner", "settings"]) }, 3),
} as const;

export type EventName = keyof typeof EVENTS;

/** What the commit-time type of a call site's properties looks like: the
 * same keys the registry lists, so a typo is a compile error before it is a
 * dropped event. */
type Infer<F extends PropField> = F["spec"] extends { kind: "bool" }
  ? boolean
  : F["spec"] extends { kind: "count" }
    ? number
    : F["spec"] extends { kind: "enumList"; values: infer V extends readonly string[] }
      ? V[number][]
      : F["spec"] extends { kind: "enum"; values: infer V extends readonly string[] }
        ? V[number]
        : string;

type RequiredKeys<D extends Record<string, PropField>> = { [K in keyof D]: D[K] extends { optional: true } ? never : K }[keyof D];
type OptionalKeys<D extends Record<string, PropField>> = Exclude<keyof D, RequiredKeys<D>>;

type Fields<N extends EventName> = (typeof EVENTS)[N]["fields"];
type Typed<F> = F extends PropField ? Infer<F> : never;

export type EventProps<N extends EventName> = { [K in RequiredKeys<Fields<N>>]: Typed<Fields<N>[K]> } & {
  [K in OptionalKeys<Fields<N>>]?: Typed<Fields<N>[K]>;
};

function valid(spec: PropSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "bool":
      return typeof value === "boolean";
    case "count":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= spec.max;
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "enumList":
      return (
        Array.isArray(value) &&
        value.length <= spec.maxItems &&
        new Set(value).size === value.length &&
        value.every((item) => typeof item === "string" && spec.values.includes(item))
      );
    case "pattern":
      return typeof value === "string" && value.length <= spec.maxLength && spec.pattern.test(value);
  }
}

const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** The payload to send, or `null` when the event is not in the registry or
 * its properties are not exactly its schema. Never repairs: an invalid
 * payload is a bug at the call site, and a silent fix would hide it. */
export function validateEvent(name: string, props: Record<string, unknown>): Record<string, unknown> | null {
  if (!has(EVENTS, name)) return null;
  const fields: Record<string, PropField> = EVENTS[name as EventName].fields;
  for (const key of Object.keys(props)) if (!has(fields, key)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = props[key];
    if (value === undefined) {
      if (field.optional) continue;
      return null;
    }
    if (!valid(field.spec, value)) return null;
    out[key] = value;
  }
  return out;
}

export function eventRateLimit(name: EventName): number {
  return EVENTS[name].perMinute;
}
