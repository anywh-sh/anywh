import { useState, type FormEvent } from "react";
import { Field } from "@/components/firstrun/Field";
import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import { enqueueProfileSetup } from "@/lib/profileSetup";

const MAX_PORT = 65535;

/**
 * Path 01: a relay that is already running somewhere reachable. Nothing
 * here is new machinery — this is the `direct` mode of `profileSetup.ts`'s
 * pipeline, the same one an `anywh://import-profile?host=&port=` deep link
 * feeds: no claim, no join, straight to verifying `/sessions` answers. The
 * profile it saves is provisional on purpose: once the shell's profile sync
 * reaches that host's `/control/profiles`, the host's own profiles replace
 * it (`syncProfilesForHost`), labels and colours included — which is why
 * the name is optional and defaults to the address.
 *
 * `initialHost` is how the terminal path hands over: after installing a
 * relay on this very machine, the address to connect to is loopback.
 */
export function ConnectExistingMachine({ initialHost = "" }: { initialHost?: string }) {
  const copy = useDict().firstRun.connect;
  const [name, setName] = useState("");
  const [host, setHost] = useState(initialHost);
  const [portText, setPortText] = useState("8765");
  const [rejected, setRejected] = useState(false);

  const trimmedHost = host.trim();
  const port = Number(portText);
  const validPort = Number.isInteger(port) && port > 0 && port <= MAX_PORT;
  const canSubmit = trimmedHost.length > 0 && validPort;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSubmit) return;
    const accepted = enqueueProfileSetup({
      source: "params",
      params: { label: name.trim() || trimmedHost, host: trimmedHost, port },
    });
    setRejected(!accepted);
  }

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex items-end gap-2.5">
          <Field id="first-run-host" label={copy.hostLabel} className="flex-1">
            <Input
              id="first-run-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder={copy.hostPlaceholder}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="px-3 py-2.5 text-[13px]"
            />
          </Field>
          <Field id="first-run-port" label={copy.portLabel} className="w-28">
            <Input
              id="first-run-port"
              value={portText}
              onChange={(event) => setPortText(event.target.value)}
              inputMode="numeric"
              className="px-3 py-2.5 text-[13px]"
            />
          </Field>
        </div>
        <Field id="first-run-name" label={copy.nameLabel} className="max-w-xs">
          <Input
            id="first-run-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={copy.namePlaceholder}
            className="px-3 py-2.5 text-[13px]"
          />
        </Field>
        {rejected && <p className="text-xs text-destructive">{copy.alreadyQueued}</p>}
        <Button type="submit" disabled={!canSubmit} className="self-start">
          {copy.submit}
        </Button>
      </form>
    </>
  );
}
