import type { Dictionary } from "@/i18n";
import { isTailnetProfile, type Profile } from "@/lib/profiles";

export interface ProfileBadge {
  label: string;
  variant: "outline" | "secondary" | "destructive";
}

/**
 * How this device reaches the profile, as one word.
 *
 * Derived from the transport primitives the app already has, never from
 * anything about who is hosting or paying for it: a profile dialled straight
 * at a host is local, one reached through the tailnet is remote, and one the
 * account owner has disconnected is revoked regardless of either.
 *
 * Shared by the profile switcher and the settings navigation so the word
 * means the same thing in both — the two places that list every profile.
 */
export function profileBadge(
  profile: Profile,
  revoked: ReadonlySet<string>,
  dict: Dictionary,
): ProfileBadge {
  if (revoked.has(profile.id)) return { label: dict.shell.profiles.badgeRevoked, variant: "destructive" };
  // Saved but never reached — outranks the transport word, since a profile
  // that has never answered is neither usefully "local" nor "remote" yet.
  if (profile.unverified) return { label: dict.shell.profiles.badgeUnverified, variant: "outline" };
  if (isTailnetProfile(profile)) return { label: dict.shell.profiles.badgeRemote, variant: "secondary" };
  return { label: dict.shell.profiles.badgeLocal, variant: "outline" };
}
