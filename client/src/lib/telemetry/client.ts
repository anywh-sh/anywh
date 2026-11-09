import { dailyDue, markDaily, markOnce, onceDue } from "@/lib/telemetry/dedupe";
import { isPending, resolveConsent, type ConsentState } from "@/lib/telemetry/consent";
import { eventRateLimit, validateEvent, type EventName, type EventProps } from "@/lib/telemetry/events";

/** What the controller needs from the analytics SDK: one call. */
export interface Sdk {
  capture(event: string, properties: Record<string, unknown>, options: { timestamp: Date }): void;
}

export interface TelemetryDeps {
  /** The project key baked into an official build. Absent = nothing below
   * ever runs, and the SDK is never even loaded. */
  key: string | undefined;
  loadSdk: () => Promise<Sdk>;
  /** The saved choice: `null` until the banner is resolved. */
  readOptedIn: () => boolean | null;
  writeOptedIn: (value: boolean) => void;
  commonProps: () => Promise<Record<string, string>>;
  now: () => number;
}

/** `sent`: handed to the SDK. `buffered`: held in memory until consent
 * resolves. `dropped`: not in the registry, off schema, refused, over its
 * rate limit, or sent nowhere because the answer is no. */
export type TrackResult = "sent" | "buffered" | "dropped";

interface Held {
  name: EventName;
  payload: Record<string, unknown>;
  at: number;
}

/** Events kept while consent is unresolved. A launch that never gets an
 * answer must not grow memory without bound. */
const MAX_HELD = 100;
const RATE_WINDOW_MS = 60_000;

export interface Telemetry {
  /** Whether this build can send at all (it has a key). */
  readonly available: boolean;
  track<N extends EventName>(name: N, props: EventProps<N>): TrackResult;
  /** Once per local day for `key`. */
  trackDaily<N extends EventName>(key: string, name: N, props: EventProps<N>): TrackResult;
  /** Once per installation for `key`. */
  trackOnce<N extends EventName>(key: string, name: N, props: EventProps<N>): TrackResult;
  consentState(): ConsentState;
  /** The banner is on screen exactly while this is true. */
  bannerPending(): boolean;
  /** Called by the native probe's answer. */
  setEnvDisabled(disabled: boolean): void;
  /** The banner's "Got it"/close and Settings' toggle on. */
  optIn(): void;
  /** "Don't share" and Settings' toggle off: sends the one opt-out count,
   * discards what was held, saves the choice. */
  optOut(source: "banner" | "settings"): void;
  /** Re-reads the saved choice (it changed in another window or store). */
  refresh(): void;
  /** Called after anything that can change `consentState()`. */
  subscribe(listener: () => void): () => void;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const available = deps.key !== undefined && deps.key !== "";
  let envDisabled: boolean | null = null;
  let held: Held[] = [];
  // Once/daily markers for events still in `held`. They reach storage only
  // when the event is handed to the transport, so quitting before the banner
  // is answered does not burn them.
  let heldMarks = new Map<string, () => void>();
  const recent = new Map<EventName, number[]>();
  let sdk: Promise<Sdk> | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  function state(): ConsentState {
    return resolveConsent(envDisabled, deps.readOptedIn());
  }

  function withinRate(name: EventName, at: number): boolean {
    const window = (recent.get(name) ?? []).filter((t) => at - t < RATE_WINDOW_MS);
    if (window.length >= eventRateLimit(name)) {
      recent.set(name, window);
      return false;
    }
    window.push(at);
    recent.set(name, window);
    return true;
  }

  function deliver(name: EventName, payload: Record<string, unknown>, at: number, force = false): void {
    sdk ??= deps.loadSdk();
    void Promise.all([sdk, deps.commonProps()]).then(
      ([instance, common]) => {
        // Consent is read again here, not trusted from when the event was
        // accepted: a "no" that lands between the two must win.
        if (!force && state() !== "enabled") return;
        instance.capture(name, { ...common, ...payload, $process_person_profile: false }, { timestamp: new Date(at) });
      },
      () => {
        // A blocked or failed load costs the event, never the app.
        sdk = null;
      },
    );
  }

  function flush(): void {
    const batch = held;
    held = [];
    for (const mark of heldMarks.values()) mark();
    heldMarks = new Map();
    for (const item of batch) deliver(item.name, item.payload, item.at);
  }

  function track<N extends EventName>(name: N, props: EventProps<N>): TrackResult {
    if (!available) return "dropped";
    const payload = validateEvent(name, props);
    if (payload === null) return "dropped";
    const current = state();
    const at = deps.now();
    if (current === "enabled") {
      if (!withinRate(name, at)) return "dropped";
      deliver(name, payload, at);
      return "sent";
    }
    if (isPending(current)) {
      if (held.length >= MAX_HELD || !withinRate(name, at)) return "dropped";
      held.push({ name, payload, at });
      return "buffered";
    }
    return "dropped";
  }

  return {
    available,
    track,
    trackDaily(key, name, props) {
      const markKey = `daily:${key}`;
      if (heldMarks.has(markKey) || !dailyDue(key, deps.now())) return "dropped";
      const at = deps.now();
      const result = track(name, props);
      if (result === "sent") markDaily(key, at);
      else if (result === "buffered") heldMarks.set(markKey, () => markDaily(key, at));
      return result;
    },
    trackOnce(key, name, props) {
      const markKey = `once:${key}`;
      if (heldMarks.has(markKey) || !onceDue(key)) return "dropped";
      const result = track(name, props);
      if (result === "sent") markOnce(key);
      else if (result === "buffered") heldMarks.set(markKey, () => markOnce(key));
      return result;
    },
    consentState: state,
    bannerPending: () => available && state() === "pending_banner",
    setEnvDisabled(disabled) {
      envDisabled = disabled;
      if (disabled) {
        held = [];
        heldMarks = new Map();
      } else if (state() === "enabled") flush();
      notify();
    },
    optIn() {
      deps.writeOptedIn(true);
      if (state() === "enabled") flush();
      notify();
    },
    optOut(source) {
      const at = deps.now();
      const payload = validateEvent("telemetry_opted_out", { source });
      // The one event a "no" sends: without it the opt-out rate is
      // unknowable. It carries nothing but where the click was, goes only
      // when the environment is known not to forbid it, and is the last.
      if (available && envDisabled === false && payload !== null && withinRate("telemetry_opted_out", at)) deliver("telemetry_opted_out", payload, at, true);
      held = [];
      heldMarks = new Map();
      deps.writeOptedIn(false);
      notify();
    },
    refresh() {
      const current = state();
      if (current === "enabled") flush();
      else if (!isPending(current)) {
        held = [];
        heldMarks = new Map();
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
