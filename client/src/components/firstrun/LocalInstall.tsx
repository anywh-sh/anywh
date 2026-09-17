import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Field } from "@/components/firstrun/Field";
import { StepList, type StepRow, type StepStatus } from "@/components/shell/StepList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocalInstall } from "@/hooks/platform/useLocalInstall";
import { useProfileSetup } from "@/hooks/profiles/useProfileSetup";
import { useDict, type Dictionary } from "@/i18n";
import {
  INSTALL_ROWS,
  MACOS_INSTALL_ROWS,
  cancelInstall,
  confirmAddress,
  failureActions,
  reinstall,
  retryInstall,
  runPrereqs,
  enableDevMode,
  type InstallRowKey,
  type LocalFailure,
  type LocalFailureAction,
  type LocalInstallState,
  type LocalStep,
} from "@/lib/install/localInstall";
import type { AddressCandidate, AddressKind, InstallLogLine } from "@/lib/install/localRelay";
import { currentPlatform } from "@/lib/platform/platform";
import { dropQueuedProfileSetup } from "@/lib/profiles/profileSetup";
import { cn } from "@/lib/utils";

const ORDER: LocalStep[] = ["prereqs", "address", "install", "verify"];

type Copy = Dictionary["firstRun"]["local"];

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function StepBlock({
  number,
  title,
  meta,
  state,
  children,
}: {
  number: string;
  title: string;
  meta?: string;
  state: "done" | "active" | "todo";
  children?: ReactNode;
}) {
  return (
    <div className={cn("border", state === "active" ? "border-border bg-bg-sidebar" : "border-border-soft")}>
      <div className={cn("flex items-center gap-3", state === "active" ? "px-4 py-3" : "px-4 py-2.5")}>
        <span
          className={cn(
            "shrink-0 font-mono text-[10.5px] font-medium",
            state === "todo" && "text-border",
            state === "done" && "text-primary",
            state === "active" && "text-primary",
          )}
        >
          {state === "done" ? "✓" : number}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 text-sm",
            state === "active" && "font-medium text-foreground",
            state === "done" && "text-muted-foreground",
            state === "todo" && "text-text-faint",
          )}
        >
          {title}
        </span>
        {meta && <span className="shrink-0 font-mono text-[11px] text-text-faint">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failure box
// ---------------------------------------------------------------------------

/** The "copy the command" affordance, shared by the failure box and the
 * agent notice — both offer the same one-line command to paste. */
function useCopyCommand(command: string | undefined) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyCommand(): Promise<void> {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied("idle"), 1500);
  }

  return { copied, copyCommand };
}

function CommandBox({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2.5 border border-border-soft bg-bg-chrome px-3 py-2">
      <span className="shrink-0 font-mono text-[11px] text-primary" aria-hidden="true">
        $
      </span>
      <code className="selectable-content min-w-0 flex-1 font-mono text-xs leading-[1.6] break-words text-foreground">{command}</code>
    </div>
  );
}

function FailureBox({
  failure,
  copy,
  onAction,
}: {
  failure: LocalFailure;
  copy: Copy;
  onAction: (action: LocalFailureAction) => void;
}) {
  const copyCopy = useDict().firstRun.copy;
  const { copied, copyCommand } = useCopyCommand(failure.command);

  const actions = failureActions(failure.code);
  return (
    <div
      role="alert"
      className="flex flex-col gap-2.5 border-t border-border-soft px-4 py-3 shadow-[inset_2px_0_0_var(--destructive)]"
    >
      <p className="text-[13.5px] leading-[1.65] text-pretty text-muted-foreground">{copy.failures[failure.code]}</p>
      {failure.detail && <p className="font-mono text-[11.5px] leading-relaxed break-words text-text-faint">{failure.detail}</p>}
      {failure.command && <CommandBox command={failure.command} />}
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant={index === 0 ? "default" : "outline"}
            onClick={() => {
              if (action === "copyCommand") void copyCommand();
              else onAction(action);
            }}
          >
            {action === "copyCommand" && copied !== "idle" ? (copied === "copied" ? copyCopy.copied : copyCopy.failed) : copy.actions[action]}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — prerequisites
// ---------------------------------------------------------------------------

type PrereqRow = "node" | "agent" | "systemd" | "brew";

function rowForCode(code: LocalFailure["code"]): PrereqRow | null {
  switch (code) {
    case "node_missing":
    case "node_old":
      return "node";
    case "brew_missing":
      return "brew";
    case "no_user_systemd":
    case "relay_running":
      return "systemd";
    default:
      return null;
  }
}

/** macOS checks Homebrew where Linux checks Node, and never a service
 * manager — `evaluatePrerequisites` never returns `no_user_systemd` there. */
function prereqRows(state: LocalInstallState, copy: Copy): StepRow[] {
  const rows: PrereqRow[] = currentPlatform() === "macos" ? ["brew", "agent"] : ["node", "agent", "systemd"];
  const { status, result, failure, warning } = state.prereqs;
  const failedRow = failure ? rowForCode(failure.code) : null;
  const failedIndex = failedRow ? rows.indexOf(failedRow) : -1;
  return rows.map((row, index) => {
    let rowStatus: StepStatus = "pending";
    if (status === "running") rowStatus = "running";
    else if (status === "ok") rowStatus = "done";
    else if (status === "failed") rowStatus = failedIndex === -1 ? "failed" : index < failedIndex ? "done" : index === failedIndex ? "failed" : "pending";
    // The agent row is the one that never blocks (`evaluateAgentReadiness`):
    // once the check has run it is either fine or a remark, whatever else
    // failed around it — so it never inherits another row's failure, and
    // never sits at "pending" behind one.
    if (row === "agent" && result) rowStatus = warning ? "warning" : "done";
    let meta: string | undefined;
    if (rowStatus === "done" && result) {
      if (row === "node" && result.nodeVersion) meta = copy.prereqs.nodeMeta.replace("{version}", result.nodeVersion);
      if (row === "agent") meta = copy.prereqs.loggedIn;
      if (row === "systemd" && state.mode === "dev") meta = copy.prereqs.devMode;
    }
    if (rowStatus === "warning" && warning) meta = copy.prereqs.agentMeta[warning.code === "agent_missing" ? "missing" : "loggedOut"];
    if (rowStatus === "running") meta = copy.prereqs.checking;
    return { key: row, label: copy.prereqs[row], status: rowStatus, meta };
  });
}

/**
 * The agent CLI's absence, said once and left visible for the rest of the
 * wizard — the prerequisites step collapses as soon as the install moves
 * past it, and this is the one thing found there that outlives it: the
 * install completes either way, and the first conversation is what will
 * run into it.
 */
function AgentNotice({ warning, copy }: { warning: LocalFailure; copy: Copy }) {
  const copyCopy = useDict().firstRun.copy;
  const { copied, copyCommand } = useCopyCommand(warning.command);
  return (
    <div
      role="status"
      className="flex flex-col gap-2.5 border border-border-soft px-4 py-3 shadow-[inset_2px_0_0_var(--context-ring-warn)]"
    >
      <p className="text-[13.5px] leading-[1.65] text-pretty text-muted-foreground">
        {copy.agentNotice[warning.code === "agent_missing" ? "missing" : "loggedOut"]}
      </p>
      {warning.command && (
        <>
          <CommandBox command={warning.command} />
          <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void copyCommand()}>
            {copied === "idle" ? copy.actions.copyCommand : copied === "copied" ? copyCopy.copied : copyCopy.failed}
          </Button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — profile and address
// ---------------------------------------------------------------------------

function AddressForm({ candidates, copy }: { candidates: AddressCandidate[]; copy: Copy }) {
  // The id is always "default" on macOS regardless of what's typed here
  // (the Homebrew launchd service has no per-profile template) — starting
  // the field on that value instead of blank matches what will actually
  // happen instead of inviting a name that only changes the label.
  const [label, setLabel] = useState(currentPlatform() === "macos" ? "default" : "");
  const recommended = candidates.find((c) => c.recommended)?.address ?? candidates[0]?.address ?? "";
  const [choice, setChoice] = useState<string>(recommended || "custom");
  const [custom, setCustom] = useState("");
  const host = choice === "custom" ? custom.trim() : choice;
  const chosenKind: AddressKind | null = candidates.find((c) => c.address === choice)?.kind ?? null;
  const canSubmit = host.length > 0 && !/\s/.test(host);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSubmit) return;
    confirmAddress({ label, host });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5 border-t border-border-soft px-4 pt-3.5 pb-4">
      <Field id="local-profile-name" label={copy.address.nameLabel} className="max-w-xs">
        <Input
          id="local-profile-name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={copy.address.namePlaceholder}
          // Locked on macOS: the Homebrew launchd service has no
          // per-profile template, so nothing downstream would change if
          // this were edited — the id and the label both stay "default".
          disabled={currentPlatform() === "macos"}
          className="px-3 py-2.5 text-[13px]"
        />
        {currentPlatform() !== "macos" && <span className="text-xs leading-[1.6] text-pretty text-text-faint">{copy.address.nameHint}</span>}
      </Field>
      <div className="h-px bg-border-soft" />
      <p className="max-w-[56ch] text-[13.5px] leading-[1.7] text-pretty text-muted-foreground">{copy.address.body}</p>
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={copy.address.customLabel}>
        {candidates.map((candidate) => (
          <AddressOption
            key={candidate.address}
            selected={choice === candidate.address}
            onSelect={() => setChoice(candidate.address)}
            value={candidate.address}
            hint={`${copy.address.hints[candidate.kind]}${candidate.recommended ? ` · ${copy.address.recommended}` : ""}`}
          />
        ))}
        <AddressOption
          selected={choice === "custom"}
          onSelect={() => setChoice("custom")}
          value={copy.address.customLabel}
          hint={copy.address.hints.public}
        />
      </div>
      {choice === "custom" && (
        <Input
          aria-label={copy.address.customLabel}
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder={copy.address.customPlaceholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="px-3 py-2.5 text-[13px]"
        />
      )}
      {chosenKind === "loopback" && (
        <p className="border border-border-soft bg-bg-chrome px-3 py-2.5 text-[13px] leading-[1.65] text-pretty text-muted-foreground shadow-[inset_2px_0_0_var(--context-ring-warn)]">
          {copy.address.loopbackWarning}
        </p>
      )}
      <Button type="submit" disabled={!canSubmit} className="self-start">
        {copy.address.submit}
      </Button>
    </form>
  );
}

function AddressOption({ selected, onSelect, value, hint }: { selected: boolean; onSelect: () => void; value: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 border px-3 py-2.5 text-left transition-colors",
        selected ? "border-primary bg-bg-elevated" : "border-border-soft hover:border-text-faint",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("mt-1 size-2.5 shrink-0 rounded-full border", selected ? "border-primary bg-primary" : "border-border")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("font-mono text-[13px] font-medium", selected ? "text-foreground" : "text-muted-foreground")}>{value}</span>
        <span className="text-xs leading-[1.5] text-text-faint">{hint}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — install
// ---------------------------------------------------------------------------

function installRows(lines: InstallLogLine[], failed: boolean, copy: Copy): StepRow[] {
  const seen = new Map<string, { status: StepStatus; meta?: string }>();
  for (const line of lines) {
    const event = line.event;
    if (!event) continue;
    if (event.kind === "step") seen.set(event.step, { status: "running", meta: copy.install.running });
    if (event.kind === "done") {
      const meta =
        event.step === "download"
          ? event.fields.asset
          : event.step === "prereqs"
            ? event.fields.node
            : event.step === "profile"
              ? event.fields.id
              : event.step === "service"
                ? event.fields.manager
                : undefined;
      seen.set(event.step, { status: "done", meta });
    }
    if (event.kind === "fail") seen.set(event.step, { status: "failed", meta: copy.install.failed });
  }
  const rows = currentPlatform() === "macos" ? MACOS_INSTALL_ROWS : INSTALL_ROWS;
  return rows.map((key: InstallRowKey) => {
    const entry = seen.get(key);
    // A run that died on its own leaves whichever step it was in "running";
    // the failure box below says so, and the row should agree.
    const status: StepStatus = entry ? (failed && entry.status === "running" ? "failed" : entry.status) : "pending";
    return { key, label: copy.install.rows[key], status, meta: entry?.meta };
  });
}

function InstallBody({
  state,
  copy,
  onTerminal,
  onBack,
}: {
  state: LocalInstallState;
  copy: Copy;
  onTerminal: () => void;
  onBack: () => void;
}) {
  const [raw, setRaw] = useState(false);
  const setup = useProfileSetup();
  const { install } = state;
  const failed = install.status === "failed";

  function handleAction(action: LocalFailureAction): void {
    switch (action) {
      case "retry":
      case "resume":
        retryInstall();
        break;
      case "reinstall":
        reinstall();
        break;
      case "recheck":
        void runPrereqs();
        break;
      case "useDevMode":
        enableDevMode();
        break;
      case "terminal":
        onTerminal();
        break;
      case "back":
        onBack();
        break;
      case "copyCommand":
        break;
    }
  }

  return (
    <>
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
      <div className="border-t border-border-soft px-4 py-3">
        <StepList steps={installRows(install.lines, failed, copy)} label={copy.steps.install} />
      </div>
      {failed && install.failure && <FailureBox failure={install.failure} copy={copy} onAction={handleAction} />}
      <div className="flex items-center gap-3 border-t border-border-soft px-4 py-2 font-mono text-[11px] text-text-faint">
        <button type="button" onClick={() => setRaw((v) => !v)} className="cursor-pointer transition-colors hover:text-muted-foreground">
          {raw ? copy.install.hideRaw : copy.install.showRaw}
        </button>
        <div className="flex-1" />
        {install.status === "running" && (
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
          {install.lines.map((line) => line.line).join("\n")}
        </pre>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

/**
 * Path 01. Four blocks, one expanded — the active step — with the done ones
 * collapsed above it and the pending ones dimmed below. Every fact in the
 * install block comes from the installer's porcelain; the wizard adds only
 * the labels. `onTerminal` hands over to the manual instructions and
 * `onBack` to the paths, both from a failure box.
 */
export function LocalInstall({ onTerminal, onBack }: { onTerminal: () => void; onBack: () => void }) {
  const copy = useDict().firstRun.local;
  const state = useLocalInstall();
  const current = ORDER.indexOf(state.step);

  function handlePrereqAction(action: LocalFailureAction): void {
    if (action === "recheck") void runPrereqs();
    else if (action === "useDevMode") enableDevMode();
    else if (action === "terminal") onTerminal();
    else if (action === "back") onBack();
  }

  const metaFor = (step: LocalStep): string | undefined => {
    if (step === "prereqs" && state.prereqs.result?.nodeVersion) return copy.prereqs.nodeMeta.replace("{version}", state.prereqs.result.nodeVersion);
    if (step === "address" && state.install.params) return `${state.install.params.label.trim() || copy.address.namePlaceholder} · ${state.install.params.host}`;
    if (step === "install" && state.install.profile) return state.install.profile.id;
    return undefined;
  };

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="flex-1 font-display text-[29px] leading-[1.2] font-bold tracking-[-0.03em] text-foreground">{copy.title}</h1>
          <span className="shrink-0 font-mono text-[11px] font-medium text-text-faint">{copy.stepOf.replace("{n}", String(current + 1))}</span>
        </div>
        {state.note !== "none" && <p className="font-mono text-xs text-text-faint">{copy.notes[state.note]}</p>}
      </section>

      {state.prereqs.warning && <AgentNotice warning={state.prereqs.warning} copy={copy} />}

      <div className="flex flex-col gap-2">
        {ORDER.map((step, index) => {
          const blockState = index < current ? "done" : index === current ? "active" : "todo";
          return (
            <StepBlock key={step} number={`0${index + 1}`} title={copy.steps[step]} meta={blockState === "done" ? metaFor(step) : undefined} state={blockState}>
              {blockState === "active" && step === "prereqs" && (
                <>
                  <div className="border-t border-border-soft px-4 py-3">
                    <StepList steps={prereqRows(state, copy)} label={copy.steps.prereqs} />
                  </div>
                  {state.prereqs.failure && <FailureBox failure={state.prereqs.failure} copy={copy} onAction={handlePrereqAction} />}
                </>
              )}
              {blockState === "active" && step === "address" && <AddressForm candidates={state.candidates} copy={copy} />}
              {blockState === "active" && step === "install" && <InstallBody state={state} copy={copy} onTerminal={onTerminal} onBack={onBack} />}
              {blockState === "active" && step === "verify" && (
                <p className="border-t border-border-soft px-4 py-3 text-[13.5px] text-muted-foreground">{copy.verify.body}</p>
              )}
            </StepBlock>
          );
        })}
      </div>
    </>
  );
}
