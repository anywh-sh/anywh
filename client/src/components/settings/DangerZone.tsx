import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteProfileDialog } from "@/components/settings/DeleteProfileDialog";
import { useDict } from "@/i18n";
import { isTailnetProfile, removeProfile, type Profile } from "@/lib/profiles/profiles";
import { deleteProfile } from "@/lib/relay/relayClient";
import { clearProfileRevoked } from "@/lib/profiles/profileRevocation";

/** Picks another profile on the same relay as `scopedProfile` to run an
 * operation that must never execute through the profile's own relay
 * (deleting would make that relay disable its own systemd
 * instance mid-request). Exported for `DangerZone.test.tsx` — pure logic,
 * no need to render anything to exercise it.
 *
 * A tailnet profile never has a valid executor: each one is its own
 * isolated sandbox behind the "127.0.0.1" sidecar placeholder every
 * tailnet profile shares (see ThemeSection's registry comment), so a host
 * match there proves nothing about actually sharing a machine — in either
 * direction. `isTailnetProfile(scopedProfile)` rules out the first
 * direction (another tailnet profile looking like a same-host sibling);
 * excluding a tailnet `p` from the candidates rules out the second (a real
 * loopback direct profile matching a tailnet profile's placeholder host). */
export function findSameHostExecutor(scopedProfile: Profile, allProfiles: Profile[]): Profile | undefined {
  if (isTailnetProfile(scopedProfile)) return undefined;
  return allProfiles.find((p) => p.id !== scopedProfile.id && p.host === scopedProfile.host && !isTailnetProfile(p));
}

/** The bottom of a profile's page: the one thing here that destroys
 * something. Framed in the destructive colour rather than hidden behind
 * another tab — it should be findable, just impossible to hit by accident
 * (see `DeleteProfileDialog`).
 *
 * Exported for `DangerZone.test.tsx` on its own: rendering the whole
 * settings dialog just to reach this section would drag in every other
 * page's dependencies (theme registry fetches, model preference, folder
 * picker) for no benefit. */
export function DangerZone({
  scopedProfile,
  allProfiles,
  onProfileRemoved,
}: {
  scopedProfile: Profile;
  allProfiles: Profile[];
  onProfileRemoved: (removedId: string) => void;
}) {
  const dict = useDict();
  const copy = dict.settings.danger;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executor = findSameHostExecutor(scopedProfile, allProfiles);
  // A tailnet/brokered profile (paired via the dashboard's join code) has no
  // `/control/profiles` host to call at all — `findSameHostExecutor` always
  // returns `undefined` for one, by design (see its own comment). The
  // server-delete flow below genuinely doesn't apply to it, so it gets its
  // own local-only removal instead of a permanently disabled button with a
  // hint ("needs another profile on the same host") that would be actively
  // wrong here — no other profile could ever make that button work for a
  // tailnet profile.
  const tailnet = isTailnetProfile(scopedProfile);

  async function handleDeleteFromServer(): Promise<void> {
    if (!executor) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteProfile(executor.host, executor.relayPort, scopedProfile.id);
      // Optimistic local removal for immediate feedback on this device —
      // `useActiveProfile`'s own reactive fallback handles switching away if
      // this happened to be the active profile, and every other device
      // picks up the removal on its next profile sync (useProfileSync).
      removeProfile(scopedProfile.id);
      onProfileRemoved(scopedProfile.id);
      setConfirmOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  function handleRemoveLocal(): void {
    // Nothing server-side to call — a paired device is disconnected from
    // the dashboard, which is what actually revokes it; this only clears
    // the local entry (same action `RevokedProfileBanner` offers once a
    // profile is already revoked — this is the same thing, offered
    // proactively instead of waiting for that to happen).
    removeProfile(scopedProfile.id);
    clearProfileRevoked(scopedProfile.id);
    onProfileRemoved(scopedProfile.id);
    setConfirmOpen(false);
  }

  return (
    <div className="mt-7 border border-destructive/70">
      <h3 className="border-b border-destructive/70 px-3 py-2 font-mono text-[9.5px] tracking-[0.12em] text-destructive uppercase">
        {copy.heading}
      </h3>

      <div className="flex items-start gap-6 bg-destructive/5 px-3 py-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[13.5px] font-semibold text-foreground">
            {tailnet ? copy.removeTitle : copy.deleteTitle}
          </span>
          <span className="text-xs leading-relaxed text-pretty text-muted-foreground">
            {tailnet ? copy.removeBody : executor ? copy.deleteBody : copy.noExecutorBody}
          </span>
          {/* Removing the only profile is allowed and lands on the first-run
              screen — worth knowing before the button, not after. */}
          {allProfiles.length === 1 && (
            <span className="text-xs leading-relaxed text-pretty text-muted-foreground">{copy.lastProfile}</span>
          )}
          {/* Only while the dialog that produced it is closed — otherwise
              the same sentence would be on screen twice. */}
          {error && !confirmOpen && <span className="pt-1 text-xs text-destructive">{error}</span>}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-destructive text-destructive hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
          disabled={!tailnet && !executor}
          onClick={() => {
            setError(null);
            setConfirmOpen(true);
          }}
        >
          {tailnet ? copy.remove : copy.delete}
        </Button>
      </div>

      <DeleteProfileDialog
        profile={scopedProfile}
        tailnet={tailnet}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        busy={deleting}
        error={error}
        onConfirm={() => {
          if (tailnet) handleRemoveLocal();
          else void handleDeleteFromServer();
        }}
      />
    </div>
  );
}
