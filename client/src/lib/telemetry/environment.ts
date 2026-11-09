import { invoke } from "@tauri-apps/api/core";
import { arch, platform, version } from "@tauri-apps/plugin-os";
import { APP_VERSION } from "@/lib/install/appVersion";
import { inTauri } from "@/lib/platform/tauri";
import { LOCALE_STORAGE_KEY, resolveInitialLocale } from "@/i18n/config";

/**
 * What every event says about the machine it came from, each reduced to a
 * closed list or a major number: nothing here identifies a person or a
 * machine, only a kind of installation.
 */
export interface CommonProps {
  app_version: string;
  os: string;
  arch: string;
  /** The OS's major version only (`14`, `11`, `6`). */
  os_release: string;
  channel: string;
  locale: string;
}

const OSES = ["macos", "windows", "linux", "ios", "android"];
const ARCHES = ["x86_64", "aarch64", "arm", "x86"];
const CHANNELS = ["appimage", "appdir", "system-package", "app-bundle", "nsis", "e2e", "unknown"];

function oneOf(list: readonly string[], value: string | undefined): string {
  return value !== undefined && list.includes(value) ? value : "other";
}

/** The first run of digits in the OS version, `other` when there are none —
 * a Linux kernel string is `6.12.63+deb13-amd64`, of which only `6` leaves. */
export function majorOf(release: string | undefined): string {
  const match = /^\D*(\d{1,4})/.exec(release ?? "");
  return match?.[1] ?? "other";
}

function currentLocale(): string {
  let stored: unknown = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // No storage: fall through to the system language.
  }
  return resolveInitialLocale(stored, typeof navigator !== "undefined" ? navigator.languages : []);
}

let cached: Promise<Omit<CommonProps, "locale">> | null = null;

async function loadStatic(): Promise<Omit<CommonProps, "locale">> {
  if (!inTauri()) return { app_version: APP_VERSION, os: "other", arch: "other", os_release: "other", channel: "unknown" };
  let channel = "unknown";
  try {
    const origin = await invoke<{ channel: string }>("app_install_source");
    channel = oneOf(CHANNELS, origin.channel);
  } catch {
    // The probe is missing on a build that does not ship it.
  }
  return {
    app_version: APP_VERSION,
    os: oneOf(OSES, platform()),
    arch: oneOf(ARCHES, arch()),
    os_release: majorOf(version()),
    channel,
  };
}

export async function commonProps(): Promise<CommonProps> {
  cached ??= loadStatic();
  return { ...(await cached), locale: currentLocale() };
}

/** Whether `DO_NOT_TRACK` or `ANYWH_TELEMETRY_DISABLED` is set in the app's
 * environment. The webview cannot read the process environment, so the
 * native side answers. Where there is no native side that has the command
 * (a plain browser, iOS) nothing can have set it for this process. */
export async function readEnvDisabled(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await invoke<boolean>("telemetry_env_disabled");
  } catch {
    return false;
  }
}
