import { useState, type FormEvent } from "react";
import { Field } from "@/components/firstrun/Field";
import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import { parsePairingCode } from "@/lib/profiles/pairingCode";
import { enqueueProfileSetup } from "@/lib/profiles/profileSetup";

/**
 * Path 02: a typed `<join-code>@<host>` pairing code. The first-run twin of
 * `AddRemoteMachineDialog` — same parse, same queue, same
 * `ProfileSetupDialog` showing the outcome — without the dialog, because
 * there is no shell for a dialog to sit on yet. The code's own format copy
 * is shared with that dialog on purpose: it describes the code, not the
 * screen.
 */
export function PairByCode() {
  const dict = useDict();
  const copy = dict.firstRun.code;
  const format = dict.shell.profiles.pair;
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [rejected, setRejected] = useState(false);

  // Parsed up front so the host is on screen before anything is sent: the
  // code names the machine that's about to receive this device's public key,
  // and that's worth seeing rather than trusting blind.
  const parsed = code.trim() ? parsePairingCode(code) : null;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!parsed) return;
    const accepted = enqueueProfileSetup({ source: "pairingCode", label: name.trim() || parsed.origin, code });
    setRejected(!accepted);
  }

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field id="first-run-code" label={copy.codeLabel} className="max-w-sm">
          <Input
            id="first-run-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={format.codePlaceholder}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="px-3 py-2.5 text-[13px] tracking-[0.08em]"
          />
        </Field>
        <Field id="first-run-pair-name" label={copy.nameLabel} className="max-w-xs">
          <Input
            id="first-run-pair-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={copy.namePlaceholder}
            className="px-3 py-2.5 text-[13px]"
          />
        </Field>
        {parsed && (
          <p className="text-xs text-muted-foreground">
            {format.willPair.split("{origin}")[0]}
            <span className="font-mono text-foreground">{parsed.origin}</span>
            {format.willPair.split("{origin}")[1]}
          </p>
        )}
        {code.trim() && !parsed && <p className="text-xs text-muted-foreground">{format.format}</p>}
        {rejected && <p className="text-xs text-destructive">{copy.alreadyQueued}</p>}
        <Button type="submit" disabled={!parsed} className="self-start">
          {copy.submit}
        </Button>
      </form>
    </>
  );
}
