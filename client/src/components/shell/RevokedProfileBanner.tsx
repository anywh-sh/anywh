import { useState } from "react";
import { Ban, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useProfileRevoked } from "@/hooks/useProfileRevoked";
import { useProfiles } from "@/hooks/useProfiles";
import { useDict } from "@/i18n";
import { clearProfileRevoked } from "@/lib/profileRevocation";
import { removeProfile, type Profile } from "@/lib/profiles";

/** The body names the profile in the middle of a sentence, and the name has
 * to be styled differently from the prose around it — which a single string
 * can't express. Splitting on the placeholder keeps the whole sentence in
 * the dictionary (where a translator can reorder it) while still letting the
 * name be its own element. */
function splitAroundProfile(template: string, label: string) {
  const [before, after = ""] = template.split("{profile}");
  return { before, label, after };
}

/**
 * Surfaces the terminal state the four reconnect loops (chat, sessions/watch,
 * terminal, files — see `markProfileRevoked` call sites) land on when the
 * broker answers 410 for this profile's own identity: the account owner
 * disconnected this device from the dashboard, and no amount of retrying
 * will ever succeed again. Chosen deliberately over auto-removing the
 * profile — a silent disappearance would be more confusing than an
 * explicit "this happened, here's what to do about it".
 *
 * Only ever renders for `profile.id` still being in the local list — once
 * removed, `useProfiles()` (wherever renders the switcher) stops offering
 * it and this stops mounting for it at all.
 */
export function RevokedProfileBanner({ profile }: { profile: Profile }) {
  const revoked = useProfileRevoked(profile.id);
  const profiles = useProfiles();
  const dict = useDict();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!revoked) return null;

  const body = splitAroundProfile(dict.shell.revoked.body, profile.label);

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-destructive bg-bg-sidebar px-4 py-3 shadow-[inset_0_2px_0_var(--destructive)]">
      <Ban className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-[10.5px] tracking-[0.11em] text-destructive uppercase">
          {dict.shell.revoked.eyebrow}
        </span>
        <span className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
          {body.before}
          <span className="font-mono text-xs text-foreground">{body.label}</span>
          {body.after}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
          {dict.shell.revoked.removeProfile}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={dict.shell.revoked.dismiss}
          onClick={() => clearProfileRevoked(profile.id)}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dict.shell.revoked.confirmTitle.replace("{profile}", profile.label)}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            <AlertDialogDescription>{dict.shell.revoked.confirmBody}</AlertDialogDescription>
            {/* Removing the only profile is allowed, and lands on the
                first-run screen — said here, before the click, rather than
                discovered after it. */}
            {profiles.length === 1 && <p className="text-sm text-muted-foreground">{dict.shell.revoked.lastProfile}</p>}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>{dict.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                removeProfile(profile.id);
                clearProfileRevoked(profile.id);
                setConfirmOpen(false);
              }}
            >
              {dict.common.remove}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One banner per revoked profile, not just `activeProfile` — a background
 * chat tab keeps its own `RelayClient` alive regardless of which profile the
 * sidebar has selected (`TabGroupLayout`'s flat panel layer, App.tsx), so its revocation
 * can be detected while the user is looking at a different profile entirely.
 * Gating the banner on `activeProfile` meant that detection was silent until
 * the user happened to switch back — this renders one per
 * profile in the list, and `RevokedProfileBanner` itself already no-ops for
 * whichever ones aren't revoked.
 */
export function RevokedProfileBanners() {
  const profiles = useProfiles();
  return (
    <>
      {profiles.map((profile) => (
        <RevokedProfileBanner key={profile.id} profile={profile} />
      ))}
    </>
  );
}
