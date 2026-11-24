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
/** What a version property accepts; `versionOrNone` (relay.ts) checks a
 * relay's version against the same one before sending it. */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,24})?$/;
export const VERSION_MAX_LENGTH = 40;
const version = { spec: { kind: "pattern", pattern: VERSION_PATTERN, maxLength: VERSION_MAX_LENGTH } } as const;
const optionalVersion = { ...version, optional: true } as const;

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
  "agent_signin",
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
  "agent_signin_failed",
  "update_failed",
  "relay_update_failed",
  "bot_create_failed",
  "bot_action_failed",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const RUNTIMES = ["claude", "codex", "other"] as const;

/** Where a prompt went: a plain conversation, a room, or a bot's own
 * conversation. */
export const PROMPT_TARGETS = ["chat", "sala", "bot"] as const;
export type PromptTarget = (typeof PROMPT_TARGETS)[number];
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

/** How a relay's version compares with the app's. `unknown`: it does not
 * say, or one of the two is a build from source. */
export const RELAY_VS_APP = ["same", "older", "newer", "unknown"] as const;
/** How a relay gets updated: by itself, by Homebrew (the app's one-click on
 * a Mac, every release), by the installer's one-time update from the app,
 * or by nothing the app can run (a source checkout, a hand-laid tree). */
export const RELAY_UPDATE_PATHS = ["self_update", "homebrew", "installer", "none"] as const;
export const RELAY_PLATFORMS = ["linux", "darwin", "other"] as const;
/** What the relay answered when the app asked it to update itself. */
export const RELAY_UPDATE_REQUEST_RESULTS = ["accepted", "unsupported", "bad_version", "not_newer", "busy", "start_failed", "unreachable", "other"] as const;
/** Why an update from the app stopped: the reasons the one-click update
 * names, plus `installer` for a self-update the installer failed. */
export const RELAY_UPDATE_REASONS = [
  "not_installed",
  "installer",
  "terminal",
  "not_back",
  "still_busy",
  "unsupported",
  "homebrew",
  "timed_out",
  "already_running",
  "other",
] as const;
/** The stable codes `install-relay.sh` fails with (`ANYWH fail <step> <code>`),
 * plus the one the app's own upgrade command prints before it runs it. */
export const INSTALLER_CODES = [
  "bad_flag",
  "checksum_mismatch",
  "checksum_missing",
  "download_failed",
  "extract_failed",
  "install_locked",
  "node_missing",
  "node_old",
  "no_user_systemd",
  "preflight_failed",
  "profile_failed",
  "relay_host_undetectable",
  "service_failed",
  "tarball_incomplete",
  "unsupported_arch",
  "unsupported_os",
  "unexpected",
  "not_installed",
  "other",
] as const;
export const INSTALLER_STEPS = ["setup", "flags", "target", "prereqs", "preflight", "download", "install", "relay_host", "profile", "service", "check", "other"] as const;
export const UPGRADE_PROMPT_SOURCES = ["banner", "bots_gate", "settings"] as const;
export type UpgradePromptSource = (typeof UPGRADE_PROMPT_SOURCES)[number];

/** Where the "New bot" dialog was opened from. */
export const BOT_CREATE_SOURCES = ["sidebar", "first_card", "templates", "ios", "other"] as const;
export type BotCreateSource = (typeof BOT_CREATE_SOURCES)[number];
/** The bot templates this build ships, or `blank` for one from scratch. */
export const BOT_TEMPLATE_KINDS = ["ci-check", "pr-review", "issue-triage", "daily-summary", "backlog-cleanup", "blank", "other"] as const;
export const BOT_CREATE_FAILURES = ["no_host", "invalid", "network", "other"] as const;
export type BotCreateFailure = (typeof BOT_CREATE_FAILURES)[number];
/** What a person does with a bot, each counted once a day. */
export const BOT_ACTIONS = [
  "open_conversation",
  "open_pane",
  "open_task",
  "answer_question",
  "answer_worker_choice",
  "cancel_task",
  "run_now",
  "pause_schedule",
  "remove_schedule",
  "pause_bot",
  "edit_settings",
  "edit_memory",
  "delete_bot",
] as const;
export type BotAction = (typeof BOT_ACTIONS)[number];

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
  /** Once a day per target: a prompt in an existing conversation counts too,
   * which `first_prompt_sent` and `session_started` never see. */
  prompt_sent: def({ target: oneOf(PROMPT_TARGETS), runtime: oneOf(RUNTIMES) }, 10),
  profile_added: def({ kind: oneOf(["local", "remote"]), pairing_method: optionalOneOf(["code", "address"]) }, 10),
  profile_connect_failed: def({
    stage: oneOf(CONNECT_FAILED_STAGES),
    reason: oneOf(CONNECT_FAILURE_REASONS),
    address_class: oneOf(ADDRESS_CLASSES),
    in_first_run: bool,
  }, 10),
  error_shown: def({ kind: oneOf(ERROR_KINDS) }, 10),
  update_installed: def({ from_version: version, to_version: version, update_mode: oneOf(UPDATE_MODES) }, 3),
  bot_create_opened: def({ source: oneOf(BOT_CREATE_SOURCES), template: oneOf(BOT_TEMPLATE_KINDS) }, 10),
  /** The "New bot" dialog closed: with a bot, or without one (and why it
   * might have stopped: the relay too old for bots, a failed attempt). */
  bot_create_ended: def({
    outcome: oneOf(["created", "abandoned"]),
    template: oneOf(BOT_TEMPLATE_KINDS),
    runtime: optionalOneOf(RUNTIMES),
    schedule_on: bool,
    gated: bool,
    failed_attempts: count(10),
    last_failure: optionalOneOf(BOT_CREATE_FAILURES),
    duration_s: count(24 * 3600),
  }, 10),
  bot_action: def({ action: oneOf(BOT_ACTIONS) }, 20),
  /** Once a day per profile: what its relay's bots look like now. The
   * schedule, run and peer counts come only from a relay that sends them. */
  bots_snapshot: def({
    bot_count: count(100),
    from_template: count(100),
    paused: count(100),
    first_run: count(100),
    scheduled: count(100),
    last_run_failed: count(100),
    limited: count(100),
    needs_you: count(1000),
    schedules: { ...count(2000), optional: true },
    runs_24h_replied: { ...count(5000), optional: true },
    runs_24h_silent: { ...count(5000), optional: true },
    runs_24h_failed: { ...count(5000), optional: true },
    runs_24h_missed: { ...count(5000), optional: true },
    runs_24h_limited: { ...count(5000), optional: true },
    peer_asks_24h: { ...count(5000), optional: true },
    peer_handoffs_24h: { ...count(5000), optional: true },
  }, 20),
  /** Once a day per profile: which release its relay runs and how it can
   * be brought up to the app's. */
  relay_seen: def({
    relay_version: optionalVersion,
    vs_app: oneOf(RELAY_VS_APP),
    update_path: oneOf(RELAY_UPDATE_PATHS),
    platform: oneOf(RELAY_PLATFORMS),
    profile_kind: oneOf(["local", "remote"]),
    has_bots: bool,
  }, 20),
  /** The app asked a relay to install its own release over itself. */
  relay_update_requested: def({ from_version: version, to_version: version, result: oneOf(RELAY_UPDATE_REQUEST_RESULTS) }, 10),
  /** How an update the app started ended: the relay's own (`auto`) or the
   * one-click one through the installer or Homebrew. */
  relay_update_finished: def({
    path: oneOf(["auto", "installer", "homebrew"]),
    outcome: oneOf(["done", "failed", "not_published", "gave_up"]),
    reason: optionalOneOf(RELAY_UPDATE_REASONS),
    installer_code: optionalOneOf(INSTALLER_CODES),
    installer_step: optionalOneOf(INSTALLER_STEPS),
    /** Where a self-update stood when the app stopped watching it. */
    last_state: optionalOneOf(["installing", "installed"]),
    from_version: optionalVersion,
    to_version: version,
    duration_s: count(24 * 3600),
  }, 10),
  /** The offer to update a relay that cannot update itself: seen (once a
   * day per place and profile), taken or closed. */
  relay_upgrade_prompt: def({
    action: oneOf(["shown", "clicked", "dismissed"]),
    kind: oneOf(["installer", "homebrew"]),
    source: oneOf(UPGRADE_PROMPT_SOURCES),
  }, 20),
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
