import { useEffect, useState } from "react";
import { CommandLine } from "@/components/firstrun/CommandLine";
import { Field } from "@/components/firstrun/Field";
import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { Segmented } from "@/components/firstrun/Segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useDict } from "@/i18n";
import type { BeginLocalInstallOptions } from "@/lib/install/localInstall";
import { localInstallPossible, suggestAddresses } from "@/lib/install/localRelay";
import { currentPlatform } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";
import { isValidHost } from "@/lib/profiles/hostAddress";
import { handleRovingKeyDown } from "@/components/firstrun/rovingKeys";

export type InstallVia = "app" | "terminal";

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = "8765";
const MAX_PORT = 65535;
const CUSTOM = "custom";

type AddressChoice = "loopback" | "lan" | "tailnet" | typeof CUSTOM;

interface AddressRow {
  choice: AddressChoice;
  /** The address itself; empty for the custom row, which is typed. */
  value: string;
}

function AddressOption({
  selected,
  onSelect,
  title,
  tag,
  hint,
  value,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  tag?: string;
  hint: string;
  value?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex min-h-[42px] w-full cursor-pointer items-center gap-2.5 border px-3 py-2 text-left outline-hidden transition-colors focus-visible:border-text-faint",
        selected ? "border-text-faint bg-surface-hover" : "border-border-soft hover:border-border",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-3 shrink-0 rounded-full border", selected ? "border-4 border-foreground" : "border-border")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className={cn("text-[13.5px]", selected ? "text-foreground" : "text-muted-foreground")}>{title}</span>
          {tag && <span className="font-mono text-[11px] text-text-faint">{tag}</span>}
        </span>
        <span className="text-xs leading-[1.5] text-text-faint">{hint}</span>
      </span>
      {value && <span className="shrink-0 font-mono text-xs text-text-faint">{value}</span>}
    </button>
  );
}

/** The id the installer would slug out of a typed name — only used to name
 * the profile in the terminal commands, which take an id, not a label. */
function slugOf(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

/**
 * Where the relay runs and how it gets installed: the one screen of the
 * onboarding that says "relay" on purpose, and the home of everything the
 * easy path hides — the address it answers on, the profile's name, dev
 * mode (a run that touches no systemd) and the install by hand.
 *
 * Two ways out. "In the app" hands the options to `onInstall` — the owner
 * starts the same install the easy path does, with these answers instead of
 * the defaults. "In the terminal" spells the install out as commands; the
 * port is only meaningful there (the in-app installer takes the first free
 * one and says which), so it is read-only on the other tab. Having run
 * them, `onConnect` points the connect form at the address and port chosen
 * here.
 */
export function AdvancedOptions({
  initialInstall,
  onInstall,
  onConnect,
}: {
  /** Defaults to the app where an in-app install exists, else the terminal. */
  initialInstall?: InstallVia;
  onInstall: (options: BeginLocalInstallOptions) => void;
  onConnect: (target: { host: string; port: number }) => void;
}) {
  const dict = useDict();
  const copy = dict.firstRun.advanced;
  const platform = currentPlatform();
  const appAvailable = localInstallPossible();
  const [via, setVia] = useState<InstallVia>(initialInstall ?? (appAvailable ? "app" : "terminal"));
  const [rows, setRows] = useState<AddressRow[]>([{ choice: "loopback", value: LOOPBACK }]);
  const [choice, setChoice] = useState<AddressChoice>("loopback");
  const [custom, setCustom] = useState("");
  // The label the field opened with: switching language afterwards must not
  // read as the reader renaming the profile (and give it a new id).
  const [initialName] = useState(dict.firstRun.profile.defaultLabel);
  const [name, setName] = useState(initialName);
  const [portText, setPortText] = useState(DEFAULT_PORT);
  const [devMode, setDevMode] = useState(false);

  // The interfaces this machine answers on. Outside the desktop app the
  // call rejects and only the loopback row (and the custom one) remain —
  // a missing Tailnet row is how "not detected" looks.
  useEffect(() => {
    let cancelled = false;
    suggestAddresses()
      .then((candidates) => {
        if (cancelled) return;
        const found: AddressRow[] = [];
        for (const candidate of candidates) {
          if (candidate.kind !== "lan" && candidate.kind !== "tailnet") continue;
          if (found.some((row) => row.choice === candidate.kind)) continue;
          found.push({ choice: candidate.kind, value: candidate.address });
        }
        setRows([{ choice: "loopback", value: LOOPBACK }, ...found.sort((a, b) => (a.choice === "lan" ? -1 : b.choice === "lan" ? 1 : 0))]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const host = choice === CUSTOM ? custom.trim() : (rows.find((row) => row.choice === choice)?.value ?? LOOPBACK);
  const validHost = isValidHost(host);
  const showInvalid = choice === CUSTOM && custom.trim().length > 0 && !validHost;
  const port = Number(portText);
  const validPort = Number.isInteger(port) && port > 0 && port <= MAX_PORT;
  const renamed = name.trim() !== initialName && name.trim().length > 0;
  // Homebrew's launchd service has no per-profile template: on macOS the id
  // is `default` whatever the label says.
  const profileId = renamed && platform !== "macos" ? slugOf(name) : "default";

  // Left alone, `add-profile.sh` takes the first free port, which need not
  // be the one "already ran it, connect" dials afterwards: the port shown
  // here is always handed to it.
  const portFlag = ` --port ${validPort ? String(port) : DEFAULT_PORT}`;
  const steps =
    platform === "macos"
      ? [
          { label: copy.terminal.stepInstall, command: "brew install anywh-sh/tap/anywh-relay" },
          {
            label: copy.terminal.stepProfile,
            command: `"$(brew --prefix anywh-relay)/libexec/infra/systemd/add-profile.sh" ${profileId} --mode dev --relay-host ${host || LOOPBACK}${portFlag}`,
          },
          { label: copy.terminal.stepStart, command: "brew services start anywh-relay" },
        ]
      : [
          { label: copy.terminal.stepInstall, command: "curl -fsSL https://anywh.sh/install | sh" },
          {
            label: copy.terminal.stepProfile,
            command: `~/.local/share/anywh/infra/systemd/add-profile.sh ${profileId} --relay-host ${host || LOOPBACK}${portFlag}`,
          },
        ];

  function handleInstall(): void {
    if (!validHost) return;
    onInstall({
      label: renamed ? name.trim() : dict.firstRun.profile.defaultLabel,
      host,
      profileId: profileId === "default" ? undefined : profileId,
      mode: devMode ? "dev" : "prod",
    });
  }

  const addressLabels: Record<Exclude<AddressChoice, typeof CUSTOM>, string> = {
    loopback: copy.address.loopback,
    lan: copy.address.lan,
    tailnet: copy.address.tailnet,
  };

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />

      <div className="flex flex-col gap-2">
        <span id="first-run-address-label" className="text-[12px] font-medium text-text-faint">
          {copy.address.label}
        </span>
        <div
          className="flex flex-col gap-1.5"
          role="radiogroup"
          aria-labelledby="first-run-address-label"
          onKeyDown={(event) => handleRovingKeyDown(event, "radio")}
        >
          {rows.map((row) => (
            <AddressOption
              key={row.choice}
              selected={choice === row.choice}
              onSelect={() => setChoice(row.choice)}
              title={addressLabels[row.choice as Exclude<AddressChoice, typeof CUSTOM>]}
              tag={row.choice === "loopback" ? copy.address.default : undefined}
              hint={copy.address.hints[row.choice as Exclude<AddressChoice, typeof CUSTOM>]}
              value={row.value}
            />
          ))}
          <AddressOption
            selected={choice === CUSTOM}
            onSelect={() => setChoice(CUSTOM)}
            title={copy.address.custom}
            hint={copy.address.hints.custom}
          />
        </div>
        {choice === CUSTOM && (
          <Input
            aria-label={copy.address.custom}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder={copy.address.customPlaceholder}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={showInvalid}
            aria-describedby={showInvalid ? "first-run-address-invalid" : undefined}
            className="px-3 py-2.5 text-[13px]"
          />
        )}
        {showInvalid && (
          <p id="first-run-address-invalid" className="text-xs text-destructive">
            {copy.address.invalid}
          </p>
        )}
      </div>

      <div className="flex items-start gap-2.5">
        <Field id="first-run-profile-name" label={copy.profileName} className="flex-1">
          <Input
            id="first-run-profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            // Locked on macOS for the same reason the id is: nothing
            // downstream would change if this were edited.
            disabled={platform === "macos"}
            className="px-3 py-2.5 text-[13px]"
          />
        </Field>
        <Field id="first-run-port" label={copy.port} className="w-28">
          <Input
            id="first-run-port"
            value={portText}
            onChange={(event) => setPortText(event.target.value)}
            inputMode="numeric"
            disabled={via === "app"}
            className="px-3 py-2.5 text-[13px]"
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        {appAvailable && (
          <Segmented
            id="first-run-install"
            label={copy.install.label}
            value={via}
            onChange={setVia}
            options={[
              { value: "app", label: copy.install.app },
              { value: "terminal", label: copy.install.terminal },
            ]}
          />
        )}

        {via === "app" ? (
          <div role="tabpanel" aria-labelledby="first-run-install-app" className="flex flex-col gap-4">
            <p className="text-xs text-text-faint">{copy.portHint}</p>
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox checked={devMode} onCheckedChange={(next) => setDevMode(next === true)} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13.5px] text-foreground">{copy.devMode.label}</span>
                <span className="text-xs leading-[1.5] text-text-faint">{copy.devMode.hint}</span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-4">
              <Button type="button" disabled={!validHost} onClick={handleInstall}>
                {copy.app.cta}
              </Button>
              <span className="text-xs text-text-faint">{copy.app.hint}</span>
            </div>
          </div>
        ) : (
          <div
            // A panel only where there are tabs to switch it: without the
            // in-app install the terminal is the whole section.
            role={appAvailable ? "tabpanel" : undefined}
            aria-labelledby={appAvailable ? "first-run-install-terminal" : undefined}
            className="flex flex-col gap-4"
          >
            {platform === "windows" && <p className="text-[13.5px] leading-[1.65] text-muted-foreground">{copy.terminal.wsl}</p>}
            <ol className="flex flex-col gap-3">
              {steps.map((step, index) => (
                <li key={step.label} className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-text-faint">
                    {index + 1}. {step.label}
                  </span>
                  <CommandLine command={step.command} />
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-4">
              <Button type="button" disabled={!validHost || !validPort} onClick={() => onConnect({ host, port })}>
                {copy.terminal.done}
              </Button>
              <span className="text-xs text-text-faint">
                {copy.terminal.connectAfter.replace("{host}", host || LOOPBACK).replace("{port}", validPort ? String(port) : DEFAULT_PORT)}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
