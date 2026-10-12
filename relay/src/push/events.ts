/**
 * What a session event becomes when it is worth a push notification: a kind
 * the gateway renders, plus the two strings a person reads on the lock
 * screen. Pure. The wire shape these end up in is contract C of
 * docs/push.md; the kinds are its vocabulary.
 */

export const PUSH_EVENT_KINDS = ["turn_completed", "turn_stopped", "turn_failed", "approval_required", "choice_required"] as const;
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

/** What the session knows when it decides to notify — the manager adds
 * which session it is and when. `title`/`preview` are `null` when there is
 * nothing to say, which the gateway fills with its own wording. */
export interface PushNotificationDraft {
  kind: PushEventKind;
  title: string | null;
  preview: string | null;
}

const MAX_PREVIEW_CHARS = 160;

/** Turns the assistant's raw (markdown) reply into plain text for a
 * notification body: drops fenced code blocks entirely (unreadable cut off
 * mid-block on a lock screen) and emphasis/inline-code markers, then
 * truncates at a word boundary rather than mid-word. Deliberately not a
 * summary — the start of the real reply, at no latency and no cost.
 * Behaviorally the same as the desktop client's notification body
 * (`cleanBody` in client/src/lib/platform/notifications.ts), so a phone and
 * a desktop read the same text for the same turn. */
export function cleanBody(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  const withoutMarkdown = withoutCode.replace(/[*_`]/g, "");
  const collapsed = withoutMarkdown.trim().replace(/\s+/g, " ");
  if (collapsed.length <= MAX_PREVIEW_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_PREVIEW_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

function previewOf(...candidates: (string | undefined | null)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = cleanBody(candidate);
    if (cleaned !== "") return cleaned;
  }
  return null;
}

/** A turn ended. A finished one previews the start of the final reply and,
 * for a turn that produced no text (a tool-only reply), the person's own
 * last message — the same order the desktop notification uses. A stopped
 * one has no reply worth showing and leaves the wording to the gateway.
 * `userText` is `undefined` for a turn the relay started itself (a wake-up,
 * an answered choice): that text is an internal instruction, not something
 * the person wrote. */
export function turnEndedDraft(input: { title: string | null; stopped: boolean; lastAssistantText?: string; userText?: string }): PushNotificationDraft {
  if (input.stopped) return { kind: "turn_stopped", title: input.title, preview: null };
  return { kind: "turn_completed", title: input.title, preview: previewOf(input.lastAssistantText, input.userText) };
}

/** A turn failed. The error text stays out of the notification: it is
 * written for a log and can carry paths and command lines, and the lock
 * screen is not where those belong. */
export function turnFailedDraft(title: string | null): PushNotificationDraft {
  return { kind: "turn_failed", title, preview: null };
}

/** A prompt is waiting for the person. A tool approval says nothing but
 * that it needs one — the command being approved can hold anything. A
 * choice previews the question the agent asked, which is the agent's own
 * prose, like a reply. */
export function promptDraft(input: { title: string | null; kind: "approval" | "choice"; firstQuestion?: string }): PushNotificationDraft {
  if (input.kind === "approval") return { kind: "approval_required", title: input.title, preview: null };
  return { kind: "choice_required", title: input.title, preview: previewOf(input.firstQuestion) };
}
