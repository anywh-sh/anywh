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
import { parsePairingCode } from "@/lib/profiles/pairingCode";
import { enqueueProfileSetup } from "@/lib/profiles/profileSetup";

interface AddRemoteMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Takes a typed `<join-code>@<host>` pairing code (pairingCode.ts) and hands
 * it to `profileSetup.ts`'s queue — the same runner the deep link feeds
 * (`useProfileImport`). Redemption, connection, and the resulting UI all
 * live in `ProfileSetupDialog` now; this dialog's only job is collecting a
 * label and a code and closing itself.
 *
 * This is the deep link's fallback, and it exists because the deep link
 * can't be the only path: it's desktop-only, and on Linux/Windows it only
 * fires on a cold launch. Whoever is holding a code with the app already
 * open — or on a platform where `anywh://` was never registered — needs
 * somewhere to put it.
 *
 * Deliberately *not* `AddProfileDialog`: that one creates another Claude
 * account on the relay this client is already talking to, and
 * needs a working connection to do it. This one has no connection yet —
 * it's how you get the first one to a machine you can't otherwise reach.
 */
export function AddRemoteMachineDialog({ open, onOpenChange }: AddRemoteMachineDialogProps) {
  const dict = useDict();
  const copy = dict.shell.profiles.pair;
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setCode("");
  }, [open]);

  // Parsed up front so the host is on screen before anything is sent: the
  // code names the machine that's about to receive this device's public key,
  // and that's worth seeing rather than trusting blind.
  const parsed = code.trim() ? parsePairingCode(code) : null;
  const canSubmit = Boolean(label.trim() && parsed);

  function handlePair(): void {
    if (!canSubmit) return;
    onOpenChange(false);
    // Deferred a tick: this dialog closing and ProfileSetupDialog opening
    // are two Radix dialogs changing `open` in the same tick, which leaves
    // `pointer-events: none` stuck on `<body>` under WKWebView (macOS/iOS).
    setTimeout(() => {
      enqueueProfileSetup({ source: "pairingCode", label: label.trim(), code });
    }, 0);
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
            <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-remote-label">
              {copy.nameLabel}
            </label>
            <Input
              id="add-remote-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={copy.namePlaceholder}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-remote-code">
              {copy.codeLabel}
            </label>
            <Input
              id="add-remote-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={copy.codePlaceholder}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          {parsed && (
            <p className="text-xs text-muted-foreground">
              {copy.willPair.split("{origin}")[0]}
              <span className="font-mono text-foreground">{parsed.origin}</span>
              {copy.willPair.split("{origin}")[1]}
            </p>
          )}
          {code.trim() && !parsed && (
            <p className="text-xs text-muted-foreground">{copy.format}</p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {dict.common.cancel}
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={handlePair}>
            {copy.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
