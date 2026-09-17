import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";

/**
 * Confirms a profile's removal by having its name typed back.
 *
 * Typing rather than a second "are you sure": this is the one action in the
 * app that destroys something the user can't get back from here — access
 * keys, and the history that goes with them — and a confirmation you can
 * answer by clicking where the button already was is not a confirmation.
 *
 * A dialog rather than an inline panel inside the danger zone: the
 * settings page behind it keeps scrolling and switching profiles, and a
 * half-typed confirmation still attached to a profile you already
 * navigated away from is exactly the wrong thing to leave armed.
 */
export function DeleteProfileDialog({
  profile,
  /** A paired device is only ever removed locally — the wording and the
   * verb both change, the typing does not. */
  tailnet,
  open,
  onOpenChange,
  busy,
  error,
  onConfirm,
}: {
  profile: Profile;
  tailnet: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const dict = useDict();
  const copy = dict.settings.danger;
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) setTyped("");
  }, [open, profile.id]);

  const [beforeName, afterName] = copy.confirmPrompt.split("{name}");
  const confirmed = typed.trim() === profile.label;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tailnet ? copy.removeTitle : copy.deleteTitle}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <DialogDescription>{tailnet ? copy.removeBody : copy.deleteBody}</DialogDescription>

          <p className="text-sm text-muted-foreground">
            {beforeName}
            <span className="font-mono text-foreground">{profile.label}</span>
            {afterName}
          </p>

          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={profile.label}
            spellCheck={false}
            autoFocus
            className="focus:border-destructive"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {dict.common.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={onConfirm}
          >
            {busy ? copy.deleting : tailnet ? copy.remove : copy.delete}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
