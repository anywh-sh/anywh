import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { inTauri } from "@/lib/platform/tauri";
import type { Profile } from "@/lib/profiles/profiles";

let permissionGranted: boolean | null = null;

/** Call once at app startup — asks for the OS notification permission if it
 * hasn't been decided yet. Result stays cached for the rest of the app's
 * session; if the user denies it, the functions below become silent no-ops. */
export async function ensureNotificationPermission(): Promise<void> {
  if (!inTauri()) return;
  if (await isPermissionGranted()) {
    permissionGranted = true;
    return;
  }
  permissionGranted = (await requestPermission()) === "granted";
}

const FALLBACK_BODY = "Resposta pronta";
const STOPPED_BODY = "Interrompido";
const MAX_BODY_CHARS = 160;

/** Turns the assistant's raw (markdown) reply into a plain-text notification
 * body — drops fenced code blocks entirely (unreadable cut off mid-block in a
 * toast) and emphasis/inline-code markers, then truncates at a word boundary
 * instead of mid-word. Deliberately not a summary: just the beginning of the
 * real response, which in practice already carries the gist most of the time
 * (responses tend to lead with the answer, elaborate after), at zero latency
 * and no extra cost — replaced an AI-generated-summary approach (relay
 * round-trip via `claude -p --model haiku`) measured at 7-15s per call, too
 * slow to reliably beat the notification firing. */
function cleanBody(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  const withoutMarkdown = withoutCode.replace(/[*_`]/g, "");
  const collapsed = withoutMarkdown.trim().replace(/\s+/g, " ");
  if (collapsed.length <= MAX_BODY_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_BODY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Goes straight to the Rust `notify_turn_complete` command instead of the
 * plugin's `sendNotification`: on Windows the plugin uses PowerShell's icon
 * outside of an installed build and doesn't forward the toast click to JS,
 * so the icon and the click (window focus + tab switch) are implemented
 * natively on the Rust side (see src-tauri/src/notifications.rs and
 * hooks/useNotificationClick.ts). `sessionId`/`profileId` travel along just
 * for that click routing — title and body already arrive ready from here.
 *
 * Title is just the conversation's name (no profile prefix — tested with
 * "[Profile] summary" and it didn't look good, the profile only matters for
 * click routing, doesn't need to take up space in the title). */
function fire(tabId: string, profile: Profile, sessionTitle: string, body: string): void {
  if (!inTauri() || !permissionGranted) return;
  void invoke("notify_turn_complete", { title: sessionTitle, body: cleanBody(body), sessionId: tabId, profileId: profile.id });
}

/** Called (via `App.tsx`) when a turn ends out of focus — fires the OS
 * notification right away (no async wait, no timeout race: the caller
 * already re-checked visibility right before calling this). Interrupted
 * turns (`stopped`) show a fixed body — there's no coherent response to show
 * instead. Completed turns show the assistant's actual final reply (cleaned
 * up/truncated), falling back to the user's last message for the rare turn
 * that produced no text at all (e.g. a tool-only response). */
export function notifyTurnComplete(
  tabId: string,
  profile: Profile,
  sessionTitle: string,
  lastUserText: string | null,
  lastAssistantText: string | null,
  stopped: boolean,
): void {
  if (stopped) {
    fire(tabId, profile, sessionTitle, STOPPED_BODY);
    return;
  }
  fire(tabId, profile, sessionTitle, lastAssistantText ?? lastUserText ?? FALLBACK_BODY);
}
