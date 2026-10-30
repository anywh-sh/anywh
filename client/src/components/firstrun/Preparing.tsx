import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight } from "lucide-react";
import { OnboardingFrame } from "@/components/firstrun/OnboardingFrame";
import { isMissingFailure, PreparingFailure } from "@/components/firstrun/PreparingFailure";
import { StepIcon } from "@/components/firstrun/StepIcon";
import { useLocalInstall } from "@/hooks/platform/useLocalInstall";
import { useDict } from "@/i18n";
import {
  abandonLocalInstall,
  cancelInstall,
  preparingFailure,
  preparingOutcome,
  preparingSteps,
  retryLocalInstall,
  runPrereqs,
  type LocalFailure,
  type LocalFailureAction,
  type StepStatus,
} from "@/lib/install/localInstall";
import { adoptSteps, getAdoptState, retryVerify, rollback, subscribeAdopt } from "@/lib/profiles/adoptLocal";
import { currentPlatform } from "@/lib/platform/platform";
import { profileColorClassForIndex } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

type RowKey = "check" | "install" | "start" | "read" | "connect";

interface Row {
  key: RowKey;
  status: StepStatus;
  /** The quiet line under a running step, or the red one under a failed
   * step. */
  sub: string | null;
}

function useAdopt() {
  return useSyncExternalStore(subscribeAdopt, getAdoptState);
}

/** How long each step has been (or was) running, in whole seconds — kept
 * here, not in the state machines: it is only ever something to read. */
function useStepTimes(rows: Row[]): Partial<Record<RowKey, number>> {
  const marks = useRef<Partial<Record<RowKey, { start: number; end: number | null }>>>({});
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = rows.some((row) => row.status === "running");

  for (const row of rows) {
    const mark = marks.current[row.key];
    if (row.status === "running" && (!mark || mark.end !== null)) marks.current[row.key] = { start: mark?.start ?? Date.now(), end: null };
    else if ((row.status === "done" || row.status === "failed") && mark && mark.end === null) mark.end = Date.now();
    else if (row.status === "pending" && mark) delete marks.current[row.key];
  }

  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const times: Partial<Record<RowKey, number>> = {};
  for (const [key, mark] of Object.entries(marks.current) as Array<[RowKey, { start: number; end: number | null }]>) {
    times[key] = Math.max(0, Math.round(((mark.end ?? now) - mark.start) / 1000));
  }
  return times;
}

/**
 * The second screen of "this machine": the install's three steps (check,
 * install, start) or, when anywh is already here, the adoption's (check,
 * read the existing install, connect). One card — a progress bar, the
 * rows, the failure box when something stopped, Details and Cancel — and
 * under it the profile this ends up with.
 *
 * Purely a projection of `localInstall.ts` / `adoptLocal.ts`: whoever opens
 * this screen has already started the run. `onDone` fires once the profile
 * answers; a cancelled install, or giving up on an adoption, goes back
 * through `onCancel` (the welcome). Giving up on an adoption takes the
 * adopted profiles off the device first, so nothing is left half-set-up.
 */
export function Preparing({
  mode,
  onDone,
  onCancel,
  onTerminal,
  onOtherMachine,
}: {
  mode: "install" | "adopt";
  onDone: () => void;
  onCancel: () => void;
  onTerminal: () => void;
  onOtherMachine: () => void;
}) {
  const dict = useDict();
  const copy = dict.firstRun.preparing;
  const install = useLocalInstall();
  const adopt = useAdopt();
  const [details, setDetails] = useState(false);

  const adopting = mode === "adopt";
  const failure: LocalFailure | null = adopting ? adopt.failure : preparingFailure(install);
  const outcome = adopting ? (adopt.status === "ready" ? "ready" : adopt.status === "failed" ? "failed" : "running") : preparingOutcome(install);
  const active = adopt.profiles.find((p) => p.id === adopt.activeId) ?? null;

  const rows: Row[] = adopting
    ? adoptSteps(adopt).map(({ key, status }) => ({
        key,
        status,
        sub:
          status === "failed"
            ? ((failure && dict.firstRun.preparing.fail.codes[failure.code].line) ?? null)
            : key === "read" && adopt.profiles.length > 0
              ? (adopt.profiles.length === 1 ? copy.sub.profilesOne : copy.sub.profilesMany).replace("{count}", String(adopt.profiles.length)).replace("{names}", adopt.profiles.map((p) => p.label).join(", "))
              : key === "connect" && status === "running" && active
                ? copy.sub.waitingAt.replace("{address}", `${active.host}:${String(active.relayPort)}`)
                : null,
      }))
    : preparingSteps(install).map(({ key, status }) => {
        let sub: string | null = null;
        // Our own words outside Details: the installer's lines (and a failure's
        // raw detail, when the code has a sentence of its own) stay in it.
        if (status === "failed" && failure) sub = dict.firstRun.preparing.fail.codes[failure.code].line ?? (failure.detail || null);
        else if (status === "running" && key === "install") sub = currentPlatform() === "macos" ? copy.sub.brew : copy.sub.download;
        else if (status === "running" && key === "start" && install.install.profile)
          sub = copy.sub.waitingAt.replace(
            "{address}",
            `${install.install.profile.host ?? "127.0.0.1"}:${String(install.install.profile.port ?? 8765)}`,
          );
        return { key, status, sub };
      });
  const times = useStepTimes(rows);

  const finished = rows.filter((row) => row.status === "done").length + rows.filter((row) => row.status === "running").length * 0.5;
  const progress = Math.min(1, finished / rows.length);

  // Moving on is the screen's job, once: the parent swaps it out.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (outcome === "ready") doneRef.current();
  }, [outcome]);
  const cancelled = !adopting && failure?.code === "cancelled";
  useEffect(() => {
    if (cancelled) cancelRef.current();
  }, [cancelled]);

  function handleAction(action: LocalFailureAction): void {
    switch (action) {
      case "recheck":
        void runPrereqs();
        break;
      case "retry":
        if (adopting) retryVerify();
        else retryLocalInstall();
        break;
      case "terminal":
        if (adopting) rollback();
        onTerminal();
        break;
      case "back":
        if (adopting) rollback();
        onCancel();
        break;
      case "otherMachine":
        if (adopting) rollback();
        onOtherMachine();
        break;
    }
  }

  function handleCancel(): void {
    if (adopting) {
      rollback();
      onCancel();
    } else if (install.install.status === "running") {
      // The done event comes back as `cancelled`, which leaves on its own.
      void cancelInstall();
    } else {
      abandonLocalInstall();
      onCancel();
    }
  }

  const title = failure
    ? isMissingFailure(failure.code)
      ? copy.fail.titleMissing
      : copy.fail.titleStopped
    : adopting
      ? copy.adoptTitle
      : copy.title;
  const body = failure ? copy.fail.keepsProgress : adopting ? copy.adoptBody : copy.body;
  const note = !adopting && !failure && (install.note === "resuming" || install.note === "reattached") ? copy[install.note] : null;
  const rawLines = install.install.lines.map((line) => line.line);
  // A failure found before the installer ran (the client-side check) has no
  // line of output to show it in; its detail joins Details instead.
  const failureDetail = failure?.detail && !rawLines.some((line) => line.includes(failure.detail)) ? failure.detail : null;
  // Cancel stays while something is still to be decided — running, or
  // stopped: it is also how the reader gives up and goes back.
  const cancellable = outcome === "running" || outcome === "failed";
  const steps = [
    { id: "machine", label: dict.firstRun.frame.steps.thisMachine },
    { id: "agents", label: dict.firstRun.frame.steps.agents },
  ];

  return (
    <OnboardingFrame steps={steps} current="machine">
      <section className="flex flex-col gap-3">
        <h1 className="font-display text-[29px] leading-[1.2] font-bold tracking-[-0.03em] text-balance text-foreground">{title}</h1>
        <p className="max-w-[56ch] text-[14px] leading-[1.7] text-pretty text-muted-foreground">{body}</p>
        {note && <p className="font-mono text-[11.5px] text-text-faint">{note}</p>}
      </section>

      <div className="flex flex-col gap-3">
        <div className="border border-border-soft bg-bg-chrome">
          <div
            className="h-0.5 bg-border-soft"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={title}
          >
            <div
              className={cn("h-full origin-left transition-transform", failure ? "bg-destructive" : "bg-foreground")}
              style={{ transform: `scaleX(${String(progress)})` }}
            />
          </div>
          <ol className="flex flex-col gap-1 px-4 py-3" aria-live="polite">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-1 py-1.5">
                <div className="flex items-center gap-3">
                  <StepIcon status={row.status} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-[14px]",
                      row.status === "pending" ? "text-text-faint" : row.status === "done" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {copy.steps[row.key]}
                  </span>
                  {row.status === "failed" ? (
                    <span className="shrink-0 font-mono text-[11.5px] text-destructive">{copy.failed}</span>
                  ) : (
                    times[row.key] !== undefined && (
                      <span className="shrink-0 font-mono text-[11.5px] text-text-faint">{`${String(times[row.key])}s`}</span>
                    )
                  )}
                </div>
                {row.sub && (
                  <p
                    className={cn("ml-[26px] font-mono text-[11.5px] break-words", row.status === "failed" ? "text-destructive" : "text-text-faint")}
                  >
                    {row.sub}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {failure && !cancelled && <PreparingFailure code={failure.code} onAction={handleAction} />}
          <div className="flex items-center gap-3 border-t border-border-soft px-4 py-2">
            <button
              type="button"
              aria-expanded={details}
              onClick={() => setDetails((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1 text-[12.5px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", details && "rotate-90")} aria-hidden="true" />
              {copy.details}
            </button>
            <div className="flex-1" />
            {cancellable && (
              <button
                type="button"
                onClick={handleCancel}
                className="cursor-pointer text-[12.5px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline"
              >
                {copy.cancel}
              </button>
            )}
          </div>
          {details && (
            <pre className="scrollbar-thin selectable-content max-h-40 overflow-auto border-t border-border-soft px-4 py-3 font-mono text-[11.5px] leading-[1.75] break-all whitespace-pre-wrap text-text-faint">
              {adopting ? adopt.profiles.map((p) => `${p.id}  ${p.host}:${String(p.relayPort)}`).join("\n") : [...rawLines, ...(failureDetail ? [failureDetail] : [])].join("\n")}
            </pre>
          )}
        </div>

        {adopting ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-faint">
            {copy.profilesHere}
            {adopt.profiles.map((p, index) => (
              <span key={p.id} className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className={cn("size-2 shrink-0", profileColorClassForIndex(index))} aria-hidden="true" />
                {p.label}
              </span>
            ))}
          </p>
        ) : (
          install.params && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-faint">
              {copy.profileSummary.before}
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className={cn("size-2 shrink-0", profileColorClassForIndex(0))} aria-hidden="true" />
                {install.params.label}
              </span>
              {/* Only loopback is "this machine only" — the advanced options can
               * pick an address other devices reach. */}
              {install.params.host === "127.0.0.1" && copy.profileSummary.after}
            </p>
          )
        )}
      </div>
    </OnboardingFrame>
  );
}
