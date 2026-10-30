import { useState } from "react";
import { StepList, type StepRow } from "@/components/shell/StepList";
import { Button } from "@/components/ui/button";
import { useLocalInstall } from "@/hooks/platform/useLocalInstall";
import { useProfileSetup } from "@/hooks/profiles/useProfileSetup";
import { useDict, type Dictionary } from "@/i18n";
import {
  cancelInstall,
  failureActions,
  preparingFailure,
  preparingSteps,
  retryLocalInstall,
  runPrereqs,
  type LocalFailure,
  type LocalFailureAction,
} from "@/lib/install/localInstall";
import { dropQueuedProfileSetup } from "@/lib/profiles/profileSetup";

type Copy = Dictionary["firstRun"]["local"];

function FailureBox({ failure, copy, onAction }: { failure: LocalFailure; copy: Copy; onAction: (action: LocalFailureAction) => void }) {
  const actions = failureActions(failure.code);
  return (
    <div role="alert" className="flex flex-col gap-2.5 border-t border-border-soft px-4 py-3 shadow-[inset_2px_0_0_var(--destructive)]">
      <p className="text-[13.5px] leading-[1.65] text-pretty text-muted-foreground">{copy.failures[failure.code]}</p>
      {failure.detail && <p className="font-mono text-[11.5px] leading-relaxed break-words text-text-faint">{failure.detail}</p>}
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => (
          <Button key={action} type="button" size="sm" variant={index === 0 ? "default" : "outline"} onClick={() => onAction(action)}>
            {copy.actions[action]}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Path 01: the three steps of `localInstall.ts` — check, install, start —
 * with the failure box, the raw output and the cancel under them. The
 * install asks nothing: the profile is `default` on loopback.
 */
export function LocalInstall({ onTerminal, onBack }: { onTerminal: () => void; onBack: () => void }) {
  const copy = useDict().firstRun.local;
  const state = useLocalInstall();
  const setup = useProfileSetup();
  const [raw, setRaw] = useState(false);
  const failure = preparingFailure(state);

  const rows: StepRow[] = preparingSteps(state).map((step) => ({
    key: step.key,
    label: copy.steps[step.key],
    status: step.status,
    meta: step.status === "running" ? (step.liveLine ?? copy.install.running) : step.status === "failed" ? copy.install.failed : undefined,
  }));

  function handleAction(action: LocalFailureAction): void {
    switch (action) {
      case "recheck":
        void runPrereqs();
        break;
      case "retry":
        retryLocalInstall();
        break;
      case "terminal":
        onTerminal();
        break;
      case "back":
      case "otherMachine":
        onBack();
        break;
    }
  }

  return (
    <>
      <section className="flex flex-col gap-3">
        <h1 className="font-display text-[29px] leading-[1.2] font-bold tracking-[-0.03em] text-foreground">{copy.title}</h1>
        {state.note !== "none" && <p className="font-mono text-xs text-text-faint">{copy.notes[state.note]}</p>}
      </section>

      <div className="border border-border bg-bg-sidebar">
        {setup.held && setup.queuedCount > 0 && (
          <div className="flex items-center gap-2.5 bg-primary-soft px-4 py-2 shadow-[inset_2px_0_0_var(--primary)]">
            <span className="size-1.5 shrink-0 bg-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 font-mono text-xs text-primary-ink">
              {setup.queuedCount > 1 ? copy.install.pendingLinks.replace("{count}", String(setup.queuedCount)) : copy.install.pendingLink}
            </span>
            <button
              type="button"
              onClick={dropQueuedProfileSetup}
              className="shrink-0 cursor-pointer font-mono text-[11px] text-text-faint transition-colors hover:text-foreground"
            >
              {copy.install.discard}
            </button>
          </div>
        )}
        <div className="px-4 py-3">
          <StepList steps={rows} label={copy.title} />
        </div>
        {failure && <FailureBox failure={failure} copy={copy} onAction={handleAction} />}
        <div className="flex items-center gap-3 border-t border-border-soft px-4 py-2 font-mono text-[11px] text-text-faint">
          <button type="button" onClick={() => setRaw((v) => !v)} className="cursor-pointer transition-colors hover:text-muted-foreground">
            {raw ? copy.install.hideRaw : copy.install.showRaw}
          </button>
          <div className="flex-1" />
          {state.install.status === "running" && (
            <button type="button" onClick={() => void cancelInstall()} className="cursor-pointer transition-colors hover:text-muted-foreground">
              {copy.install.cancel}
            </button>
          )}
          <button type="button" onClick={onTerminal} className="cursor-pointer transition-colors hover:text-muted-foreground">
            {copy.install.terminal}
          </button>
        </div>
        {raw && (
          <pre className="scrollbar-thin selectable-content max-h-40 overflow-auto border-t border-border-soft bg-bg-chrome px-4 py-2.5 font-mono text-[11px] leading-[1.85] break-all whitespace-pre-wrap text-text-faint">
            {state.install.lines.map((line) => line.line).join("\n")}
          </pre>
        )}
      </div>
    </>
  );
}
