import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Field } from "@/components/firstrun/Field";
import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { QuietLink } from "@/components/firstrun/QuietLink";
import { Segmented } from "@/components/firstrun/Segmented";
import { StepRows } from "@/components/firstrun/StepIcon";
import type { StepRow } from "@/components/shell/StepList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProfileSetup } from "@/hooks/profiles/useProfileSetup";
import { useDict } from "@/i18n";
import { parsePairingCode } from "@/lib/profiles/pairingCode";
import { findProfile, removeProfile } from "@/lib/profiles/profiles";
import { dismissProfileSetup, enqueueProfileSetup, retryProfileSetup, type SetupState } from "@/lib/profiles/profileSetup";
import { isValidHost } from "@/lib/profiles/hostAddress";

export type OtherMachineMode = "code" | "address";
export type ReadySetup = Extract<SetupState, { status: "ready" }>;

const MAX_PORT = 65535;
const DEFAULT_PORT = "8765";

/** Which of the three rows is running, done or stopped, read off the
 * pipeline's own state. The claim row only exists for a typed code: an
 * address is the `direct` mode of `profileSetup.ts` — no claim, straight to
 * connecting. */
function progressRows(state: SetupState | null, mode: OtherMachineMode, copy: { claiming: string; connecting: string; verifying: string }): StepRow[] {
  const order = mode === "code" ? (["claiming", "connecting", "verifying"] as const) : (["connecting", "verifying"] as const);
  const at = (stage: "claiming" | "connecting" | "verifying"): number => order.indexOf(stage as never);
  // `reached` is the index of the row the pipeline is on; everything before
  // it is done. `failedAt` marks the row that stopped.
  let reached = 0;
  let failedAt = -1;
  if (state?.status === "claiming") reached = at("claiming");
  else if (state?.status === "connecting") reached = at("connecting");
  else if (state?.status === "verifying") reached = at("verifying");
  else if (state?.status === "ready") reached = order.length;
  else if (state?.status === "failed") {
    failedAt = at(state.stage === "claim" ? "claiming" : state.stage === "connect" ? "connecting" : "verifying");
    reached = failedAt;
  }
  return order.map((key, index) => ({
    key,
    label: copy[key],
    status: index === failedAt ? "failed" : index < reached ? "done" : index === reached ? "running" : "pending",
  }));
}

/**
 * Connecting to a machine that is already running somewhere — and the
 * first screen where there is nothing else to do (the browser). A pairing
 * code or an address feed the same `profileSetup.ts` queue a deep link or
 * the profile switcher's dialog does; the outcome is drawn inline here
 * instead of in `ProfileSetupDialog`, because the reader should never
 * leave the screen to learn whether it worked. The profile a direct
 * address saves is provisional on purpose: once the shell syncs that
 * host's `/control/profiles`, the host's own labels replace it — which is
 * why there is no name field.
 *
 * `onReady` fires once, with the verified profile; whoever owns the flow
 * decides where it goes next (the agents of that machine).
 */
export function OtherMachine({
  initialMode = "code",
  initialHost = "",
  initialPort,
  onAdvanced,
  onReady,
}: {
  initialMode?: OtherMachineMode;
  initialHost?: string;
  initialPort?: number;
  onAdvanced: () => void;
  onReady: (setup: ReadySetup) => void;
}) {
  const copy = useDict().firstRun.other;
  const setup = useProfileSetup();
  const [mode, setMode] = useState<OtherMachineMode>(initialMode);
  const [code, setCode] = useState("");
  const [host, setHost] = useState(initialHost);
  const [portText, setPortText] = useState(initialPort ? String(initialPort) : DEFAULT_PORT);
  const [rejected, setRejected] = useState(false);
  // What this screen itself started: a profile setup already running when
  // the screen mounts (a deep link) is shown too, but only a submission
  // here decides which rows to draw.
  const [submitted, setSubmitted] = useState<OtherMachineMode | null>(null);
  // A setup already `ready` when this screen mounts belongs to a profile set
  // up earlier (the agents step left for another machine): it is neither
  // this screen's progress nor its to announce — announcing it would bounce
  // straight back to that profile's agents.
  const [staleReady] = useState(() => setup.state?.status === "ready");

  const parsed = code.trim() ? parsePairingCode(code) : null;
  const trimmedHost = host.trim();
  const port = Number(portText);
  const validPort = Number.isInteger(port) && port > 0 && port <= MAX_PORT;
  const hostInvalid = trimmedHost.length > 0 && !isValidHost(trimmedHost);
  const canSubmit = mode === "code" ? parsed !== null : isValidHost(trimmedHost) && validPort;

  const state = setup.state;
  const showingProgress = state !== null && (submitted !== null || (state.status !== "failed" && !(staleReady && state.status === "ready")));
  const progressMode = submitted ?? (state?.mode === "tailnet" ? "code" : "address");

  const announced = useRef(staleReady);

  // Leaving while this screen's own request is still running (Back) means
  // giving up on it: it is let go, so it neither pulls the reader back here
  // nor holds the queue for what they do next. A link that started on its
  // own is not this screen's to drop.
  const ownInFlight = useRef(false);
  ownInFlight.current = submitted !== null && state !== null && (state.status === "claiming" || state.status === "connecting" || state.status === "verifying");
  useEffect(
    () => () => {
      if (ownInFlight.current) dismissProfileSetup();
    },
    [],
  );
  useEffect(() => {
    if (state?.status === "ready" && !announced.current) {
      announced.current = true;
      onReady(state);
    }
    if (state?.status !== "ready") announced.current = false;
  }, [state, onReady]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSubmit) return;
    // A failed attempt left from before (the reader went back and is now
    // trying again, maybe elsewhere) would hold the queue: let it go, and
    // with it the profile it saved but never reached.
    if (state?.status === "failed") {
      const left = "profile" in state ? state.profile : null;
      dismissProfileSetup();
      if (left && findProfile(left.id)?.unverified) removeProfile(left.id);
    }
    const accepted =
      mode === "code" && parsed
        ? enqueueProfileSetup({ source: "pairingCode", label: parsed.origin, code })
        : enqueueProfileSetup({ source: "params", params: { label: trimmedHost, host: trimmedHost, port } });
    setRejected(!accepted);
    if (accepted) setSubmitted(mode);
  }

  /** A code that never redeemed saved nothing: clearing the failure is all
   * "try again" can mean, and it lands back on the form with the code
   * still typed. Past the claim the profile exists, so retry re-enters. */
  function handleRetry(): void {
    if (state?.status === "failed" && state.stage === "claim") {
      dismissProfileSetup();
      setSubmitted(null);
      return;
    }
    retryProfileSetup();
  }

  const failed = state?.status === "failed" ? state : null;

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />

      {showingProgress && state ? (
        <section className="flex flex-col gap-4" aria-label={copy.connecting}>
          <div className="border border-border bg-bg-chrome px-4 py-3.5">
            <StepRows steps={progressRows(state, progressMode, copy.steps)} label={copy.connecting} />
          </div>
          {failed && (
            <div role="alert" className="flex flex-col gap-3 px-4 py-3 shadow-[inset_2px_0_0_var(--destructive)]">
              <p className="text-[length:calc(13.5px*var(--font-scale-ratio))] leading-[1.65] text-pretty text-muted-foreground">{copy.failed[failed.stage]}</p>
              <Button type="button" size="sm" className="self-start" onClick={handleRetry}>
                {copy.retry}
              </Button>
            </div>
          )}
        </section>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <Segmented
            id="first-run-other-mode"
            label={copy.modes.label}
            value={mode}
            onChange={setMode}
            options={[
              { value: "code", label: copy.modes.code },
              { value: "address", label: copy.modes.address },
            ]}
          />
          <div role="tabpanel" aria-labelledby={`first-run-other-mode-${mode}`} className="flex flex-col gap-4">
            {mode === "code" ? (
              <>
                <Field id="first-run-code" label={copy.code.label}>
                  <Input
                    id="first-run-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder={copy.code.placeholder}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="px-3 py-2.5 text-[length:calc(13px*var(--font-scale-ratio))] tracking-[0.08em]"
                  />
                </Field>
                {/* The code names the machine about to receive this
                 * device's public key — worth seeing before sending. */}
                {parsed ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Check className="size-3.5 shrink-0 text-diff-add" aria-hidden="true" />
                    <span>
                      {copy.code.valid.split("{host}")[0]}
                      <span className="font-mono text-foreground">{new URL(parsed.origin).host}</span>
                      {copy.code.valid.split("{host}")[1]}
                    </span>
                  </p>
                ) : (
                  <p className="text-xs text-text-faint">{code.trim() ? copy.code.invalid : copy.code.empty}</p>
                )}
              </>
            ) : (
              <>
                <div className="flex items-end gap-2.5">
                  <Field id="first-run-host" label={copy.address.host} className="flex-1">
                    <Input
                      id="first-run-host"
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                      placeholder={copy.address.hostPlaceholder}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={hostInvalid}
                      aria-describedby={hostInvalid ? "first-run-host-invalid" : undefined}
                      className="px-3 py-2.5 text-[length:calc(13px*var(--font-scale-ratio))]"
                    />
                  </Field>
                  <Field id="first-run-port" label={copy.address.port} className="w-28">
                    <Input
                      id="first-run-port"
                      value={portText}
                      onChange={(event) => setPortText(event.target.value)}
                      inputMode="numeric"
                      className="px-3 py-2.5 text-[length:calc(13px*var(--font-scale-ratio))]"
                    />
                  </Field>
                </div>
                {hostInvalid ? (
                  <p id="first-run-host-invalid" className="text-xs text-destructive">
                    {copy.address.invalid}
                  </p>
                ) : (
                  <p className="text-xs text-text-faint">{copy.address.hint}</p>
                )}
              </>
            )}
          </div>
          {rejected && <p className="text-xs text-destructive">{copy.alreadyQueued}</p>}
          <Button type="submit" disabled={!canSubmit} className="self-start">
            {copy.connect}
          </Button>
        </form>
      )}

      {!showingProgress && <QuietLink onClick={onAdvanced}>{copy.advanced}</QuietLink>}
    </>
  );
}
