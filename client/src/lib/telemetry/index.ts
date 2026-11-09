import { readSettings, subscribeSettings, writeSettings } from "@/lib/settings";
import { createTelemetry, type Sdk, type Telemetry } from "@/lib/telemetry/client";
import { commonProps, readEnvDisabled } from "@/lib/telemetry/environment";

/**
 * The app's one telemetry instance. Everything else imports from here.
 *
 * The key exists only in an official build (the release workflow injects it
 * as `VITE_POSTHOG_KEY`). Without it `telemetry.available` is false, every
 * `track` returns at once, and the SDK is never imported — a fork or a local
 * build has no telemetry by structure, not by a setting.
 */
const KEY = import.meta.env.VITE_POSTHOG_KEY;
const HOST = import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

/** This installation's anonymous id: random, made on first use, kept in the
 * settings store. Not the push device id, which is sent to relays. */
export function installId(): string {
  const current = readSettings();
  const existing = current.app?.telemetry?.installId;
  if (existing) return existing;
  const id = crypto.randomUUID();
  writeSettings({ ...current, app: { ...current.app, telemetry: { optedIn: current.app?.telemetry?.optedIn ?? null, installId: id } } });
  return id;
}

async function loadSdk(): Promise<Sdk> {
  const { default: posthog } = await import("posthog-js");
  posthog.init(KEY ?? "", {
    api_host: HOST,
    // Nothing is collected unless an event of the registry says so: no
    // clicks, no page views, no recordings, no heatmaps, no exceptions.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    save_referrer: false,
    save_campaign_params: false,
    // Nothing about this installation persists in the SDK's own storage:
    // the id comes from the settings store, the events are fire-and-forget.
    persistence: "memory",
    person_profiles: "identified_only",
    bootstrap: { distinctID: installId(), isIdentifiedID: false },
    // What the SDK adds on its own (the page's URL, the browser, the screen,
    // the session) is dropped: only the registry's properties and the
    // handful the ingestion needs leave.
    before_send: (event) => {
      const keep = new Set(["token", "distinct_id", "$process_person_profile", "$lib", "$lib_version"]);
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event.properties)) if (keep.has(key) || !key.startsWith("$")) properties[key] = value;
      return { ...event, properties, $set: undefined, $set_once: undefined };
    },
  });
  return posthog;
}

export const telemetry: Telemetry = createTelemetry({
  key: KEY,
  loadSdk,
  readOptedIn: () => readSettings().app?.telemetry?.optedIn ?? null,
  writeOptedIn: (value) => {
    const id = installId();
    const current = readSettings();
    writeSettings({ ...current, app: { ...current.app, telemetry: { optedIn: value, installId: id } } });
  },
  commonProps: async () => ({ ...(await commonProps()) }),
  now: () => Date.now(),
});

let started = false;

/** Reads what only the native side knows (the environment) and keeps the
 * controller in step with the saved choice. A no-op without a key. Safe to
 * call more than once. */
export function startTelemetry(): void {
  if (started || !telemetry.available) return;
  started = true;
  void readEnvDisabled().then((disabled) => telemetry.setEnvDisabled(disabled));
  subscribeSettings(() => telemetry.refresh());
}
