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
import { Segmented } from "@/components/ui/segmented";
import { useDict } from "@/i18n";
import { isValidHost } from "@/lib/profiles/hostAddress";
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
type Mode = "code" | "address";
const DEFAULT_PORT = "8765";
const MAX_PORT = 65535;

export function AddRemoteMachineDialog({ open, onOpenChange }: AddRemoteMachineDialogProps) {
  const dict = useDict();
  const copy = dict.shell.profiles.pair;
  const [mode, setMode] = useState<Mode>("code");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [host, setHost] = useState("");
  const [portText, setPortText] = useState(DEFAULT_PORT);

  useEffect(() => {
    if (!open) return;
    setMode("code");
    setLabel("");
    setCode("");
    setHost("");
    setPortText(DEFAULT_PORT);
  }, [open]);

  // Parsed up front so the host is on screen before anything is sent: the
  // code names the machine that's about to receive this device's public key,
  // and that's worth seeing rather than trusting blind.
  const parsed = code.trim() ? parsePairingCode(code) : null;
  // The address mode is the first run's "Address" tab after it: a relay
  // reached directly, with no claim. The profile it saves is provisional
  // until the host's own profile list replaces it on the first sync.
  const trimmedHost = host.trim();
  const port = Number(portText);
  const validPort = Number.isInteger(port) && port > 0 && port <= MAX_PORT;
  const hostInvalid = trimmedHost.length > 0 && !isValidHost(trimmedHost);
  const canSubmit = mode === "code" ? Boolean(label.trim() && parsed) : Boolean(label.trim() && trimmedHost && !hostInvalid && validPort);

  function handlePair(): void {
    if (!canSubmit) return;
    onOpenChange(false);
    // Deferred a tick: this dialog closing and ProfileSetupDialog opening
    // are two Radix dialogs changing `open` in the same tick, which leaves
    // `pointer-events: none` stuck on `<body>` under WKWebView (macOS/iOS).
    setTimeout(() => {
      if (mode === "code") enqueueProfileSetup({ source: "pairingCode", label: label.trim(), code });
      else enqueueProfileSetup({ source: "params", params: { label: label.trim(), host: trimmedHost, port } });
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

          <Segmented
            id="add-remote-mode"
            label={copy.title}
            value={mode}
            options={[
              { value: "code", label: copy.modeCode },
              { value: "address", label: copy.modeAddress },
            ]}
            onChange={setMode}
          />

          <div role="tabpanel" aria-labelledby={`add-remote-mode-${mode}`} className="flex flex-col gap-3">
          {mode === "code" ? (
            <>
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
            </>
          ) : (
            <div className="flex gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-remote-host">
                  {copy.hostLabel}
                </label>
                <Input
                  id="add-remote-host"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder={copy.hostPlaceholder}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <label className="font-mono text-[10.5px] tracking-[0.08em] text-text-faint uppercase" htmlFor="add-remote-port">
                  {copy.portLabel}
                </label>
                <Input id="add-remote-port" value={portText} onChange={(event) => setPortText(event.target.value)} inputMode="numeric" />
              </div>
            </div>
          )}
          {mode === "address" && hostInvalid && <p className="text-xs text-muted-foreground">{copy.hostInvalid}</p>}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {dict.common.cancel}
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={handlePair}>
            {mode === "code" ? copy.submit : copy.connect}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
