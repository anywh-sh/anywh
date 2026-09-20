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
import { addProfile, type Profile } from "@/lib/profiles/profiles";
import { createProfile, validateProfile } from "@/lib/relay/relayClient";

interface AddProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose relay hosts both calls — the only machine the client already
   * knows how to reach. A new profile always lives on
   * this same host, just a different account/port. */
  activeProfile: Profile;
}

/**
 * Dialog opened from `ProfileSwitcher`'s "Adicionar perfil" item — creates a
 * brand new profile on the active host. Profiles that already exist on that
 * host (created from another device) no longer need importing here: they
 * show up in the switcher on their own via `useProfileSync`. Only rendered
 * when that hook reports the active host actually runs the control API —
 * see `ProfileSwitcher`.
 */
export function AddProfileDialog({ open, onOpenChange, activeProfile }: AddProfileDialogProps) {
  const dict = useDict();
  const copy = dict.shell.profiles.add;
  const [label, setLabel] = useState("");
  const [homePath, setHomePath] = useState("");
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ account?: string; plan?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collidesWith, setCollidesWith] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setHomePath("");
    setValidation(null);
    setError(null);
    setCollidesWith(null);
  }, [open]);

  // A field the user already validated changing again means "Criar" needs
  // another "Verificar" first — otherwise a typo fixed after a failed check
  // would silently reuse the previous (wrong) result.
  useEffect(() => {
    setValidation(null);
    setError(null);
    setCollidesWith(null);
  }, [homePath]);

  async function handleVerify(): Promise<void> {
    setValidating(true);
    setError(null);
    setCollidesWith(null);
    setValidation(null);
    try {
      const result = await validateProfile(activeProfile.host, activeProfile.relayPort, homePath.trim() || undefined);
      if (result.collidesWith) {
        setCollidesWith(result.collidesWith);
        return;
      }
      if (!result.loggedIn) {
        const homeForCommand = homePath.trim() || "<path>";
        setError(copy.notLoggedIn.replace("{path}", homeForCommand));
        return;
      }
      setValidation({ account: result.account, plan: result.plan });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleCreate(): Promise<void> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || !validation) return;
    setCreating(true);
    try {
      const created = await createProfile(activeProfile.host, activeProfile.relayPort, trimmedLabel, homePath.trim() || undefined);
      addProfile({
        id: created.id,
        label: created.label,
        host: created.host,
        relayPort: created.port,
        colorIndex: created.colorIndex,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <DialogDescription>{copy.description}</DialogDescription>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-profile-label">
              {copy.nameLabel}
            </label>
            <Input
              id="add-profile-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={copy.namePlaceholder}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-profile-home">
              {copy.homeLabel}
            </label>
            <Input
              id="add-profile-home"
              value={homePath}
              onChange={(event) => setHomePath(event.target.value)}
              placeholder={copy.homePlaceholder}
              spellCheck={false}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {collidesWith && (
            <p className="text-sm text-destructive">{copy.collides.replace("{profile}", collidesWith)}</p>
          )}
          {validation && (
            <p className="text-sm text-foreground">
              {copy.confirmed}
              {validation.account ? `: ${validation.account}` : ""}
              {validation.plan ? ` (${validation.plan})` : ""}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" disabled={validating} onClick={() => void handleVerify()}>
              {validating ? copy.verifying : copy.verify}
            </Button>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {dict.common.cancel}
          </Button>
          <Button type="button" size="sm" disabled={!validation || !label.trim() || creating} onClick={() => void handleCreate()}>
            {creating ? copy.creating : dict.common.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
