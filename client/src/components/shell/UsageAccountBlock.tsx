import { useEffect, useRef, useState } from "react";

import { agentName } from "@/components/chat/AgentModelEffortButton";
import { AgentMark } from "@/components/shell/AgentMark";
import { UsageMeter } from "@/components/shell/UsageMeter";
import { ReadingMark, noteDetail, noteText } from "@/components/shell/usageNote";
import { useDict, useLocale, type Dictionary, type Locale } from "@/i18n";
import { accountWindows, neverSignedIn, runtimeNote, runtimeWindows, spentUntil, type AccountEntry, type RuntimeNote, type WindowView } from "@/lib/planUsage/derive";
import { formatResetPhrase, formatResetTime } from "@/lib/planUsage/format";
import { profileColorClass } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

type CardStrings = Dictionary["shell"]["usage"]["card"];

/** What to run to log an agent in. Commands, not copy: the same in every
 * language. Claude's is `claude auth login` — a bare `claude login` isn't a
 * subcommand and would be taken as a prompt. */
const LOGIN_COMMANDS: Record<string, string> = {
  claude: "claude auth login",
  codex: "codex login",
};

const tone = (view: WindowView): string =>
  view.level === "limited" ? "font-medium text-err" : view.level === "warn" ? "font-medium text-warn" : "text-foreground";

/** A model-scoped window's name next to its length ("7d opus"), from the
 * last word of its id. Codex's account bucket (`codex`) is the account, not
 * a scope, and carries none. */
function scopeOf(view: WindowView): string | null {
  if (!view.limitId || view.limitId === "codex") return null;
  return view.limitId.split("_").pop() ?? view.limitId;
}

/**
 * One account under a profile in the usage card: its mark, name and plan,
 * then one row per window. A repeat of an account already shown above (same
 * `accountKey`) is a single line pointing at where it is shown in full.
 * No e-mail anywhere: the relay never sends one.
 */
export function UsageAccountBlock({
  entry,
  now,
  reading,
  profileLabel,
}: {
  entry: AccountEntry;
  now: number;
  /** A read of this account is in progress on the relay. */
  reading: boolean;
  /** Name of a profile by id, for "same account as". */
  profileLabel: (profileId: string) => string;
}) {
  const dict = useDict();
  const { locale } = useLocale();
  const strings = dict.shell.usage;
  const name = agentName(dict.chat.composer.agentNames, entry.runtime);
  const usage = entry.usage;
  const views = runtimeWindows(usage, now);

  if (entry.sameAccountAs !== undefined) {
    const owner = entry.sameAccountAs;
    const [before, after] = strings.card.sameAccount.split("{profile}");
    return (
      <div data-usage-account={entry.runtime} data-same-account={owner} className="flex h-8 items-center gap-2 px-4 text-[12px]">
        <AgentMark runtime={entry.runtime} size={18} />
        <span className="text-foreground">{name}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-text-faint">
          {before}
          <span aria-hidden="true" className={cn("size-1.5 shrink-0", profileColorClass(owner))} />
          {profileLabel(owner)}
          {after}
        </span>
        <span className="shrink-0 font-mono text-[12px]">
          {accountWindows(views).map((view, index) => (
            <span key={`${String(view.durationMins)}:${view.limitId ?? ""}`}>
              {index > 0 && <span className="text-text-faint"> · </span>}
              <span className={tone(view)}>{view.percent}%</span>
            </span>
          ))}
        </span>
      </div>
    );
  }

  if (neverSignedIn(usage) && !reading) {
    return <NotUsedLine runtime={entry.runtime} name={name} strings={strings.card} />;
  }

  const spent = views.some((view) => view.level === "limited");
  return (
    <section data-usage-account={entry.runtime} aria-label={name} className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <AgentMark runtime={entry.runtime} size={18} />
        <span className="text-[13px] text-foreground">{name}</span>
        {usage.plan && <span className="font-mono text-[11px] text-text-faint">{usage.plan.label}</span>}
        <span className="flex-1" />
        {reading && views.length > 0 && (
          <span data-usage-account-reading className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
            <ReadingMark />
            {strings.reading}
          </span>
        )}
        {spent && <span className="font-mono text-[11px] font-medium text-err">{strings.limited}</span>}
        {usage.status === "error" && views.length > 0 && (
          <span className="font-mono text-[11px] text-text-faint">{strings.card.readErrorKept}</span>
        )}
      </div>
      {views.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {views.map((view) => (
            <WindowRow key={`${String(view.durationMins)}:${view.limitId ?? ""}`} view={view} views={views} now={now} locale={locale} strings={strings} />
          ))}
        </div>
      ) : usage.status === "signed_out" && !reading ? (
        <SignedOutStrip runtime={entry.runtime} strings={strings.card} />
      ) : (
        <NoteLine note={runtimeNote(usage, now, reading) ?? "notRead"} strings={strings} />
      )}
    </section>
  );
}

/** What an account with no windows says instead: a read in progress, an API
 * key login, why a read failed, or that it was never read. */
function NoteLine({ note, strings }: { note: RuntimeNote; strings: Dictionary["shell"]["usage"] }) {
  return (
    <p data-usage-note={note} title={noteDetail(note, strings)} className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
      {note === "reading" && <ReadingMark />}
      {note === "apiKey" ? (
        <span className="border border-border px-1 text-muted-foreground">{strings.apiKey}</span>
      ) : note === "notRead" ? (
        strings.card.notReadHint
      ) : (
        noteText(note, strings)
      )}
    </p>
  );
}

function WindowRow({
  view,
  views,
  now,
  locale,
  strings,
}: {
  view: WindowView;
  views: readonly WindowView[];
  now: number;
  locale: Locale;
  strings: Dictionary["shell"]["usage"];
}) {
  const scope = scopeOf(view);
  // A spent window comes back when every spent window has: until then the
  // agent refuses, whichever of them resets first.
  const until = view.level === "limited" ? (spentUntil(views) ?? view.resetsAt) : view.resetsAt;
  const reset = until === null ? null : formatResetTime(until, now, locale);
  return (
    <div data-usage-window={view.label} className="flex items-center gap-2.5">
      <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">
        {view.label}
        {scope && <span className="text-text-faint"> {scope}</span>}
      </span>
      <UsageMeter percent={view.percent} durationMins={view.durationMins} expected={view.expected} warning={view.level === "warn"} className="flex-1" />
      <span className={cn("w-10 shrink-0 text-right font-mono text-[12px]", tone(view))}>{view.percent}%</span>
      <span className="w-[92px] shrink-0 truncate text-right font-mono text-[11px] text-text-faint">
        {view.level === "limited" ? (
          <span className="text-err">{(until !== null && formatResetPhrase(strings, until, now, locale)) || strings.limited}</span>
        ) : reset ? (
          <>
            <span aria-hidden="true">↻ {reset.text}</span>
            <span className="sr-only">
              {reset.kind === "in"
                ? strings.card.renewsIn.replace("{duration}", reset.text)
                : strings.card.renewsOn.replace("{when}", reset.text)}
            </span>
          </>
        ) : (
          <span aria-hidden="true">—</span>
        )}
      </span>
    </div>
  );
}

/** Copy a command to the clipboard; "Copied" (or the failure word) for
 * 1.5s, announced by a status region. */
function useCopy(command: string) {
  const dict = useDict();
  const copy = dict.firstRun.copy;
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }

  const button = (
    <button
      type="button"
      onClick={() => void handleCopy()}
      // Several of these can share the card; each names its command.
      aria-label={dict.shell.usage.card.copyCommand.replace("{command}", command)}
      className="h-6 shrink-0 cursor-pointer border border-border px-2 font-mono text-[11px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground"
    >
      {state === "idle" ? copy.copy : state === "copied" ? copy.copied : copy.failed}
    </button>
  );
  const status = (
    <span role="status" className="sr-only">
      {state === "copied" ? copy.copied : state === "failed" ? copy.failed : ""}
    </span>
  );
  return { button, status };
}

/** A login that was lost: the accent dot, the command that fixes it, and Copy. */
function SignedOutStrip({ runtime, strings }: { runtime: string; strings: CardStrings }) {
  const command = LOGIN_COMMANDS[runtime] ?? `${runtime} login`;
  const { button, status } = useCopy(command);
  return (
    <div data-usage-signed-out className="mt-2 flex items-center gap-2 border border-border-soft bg-bg-chrome py-1 pr-1 pl-2.5">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="shrink-0 text-[12px] text-foreground">{strings.signedOut}</span>
      <code className="selectable-content min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{command}</code>
      {button}
      {status}
    </div>
  );
}

/**
 * An agent installed but never logged in on this profile: one quiet line —
 * no accent, nothing asks for attention — that still carries the command to
 * start using it here, with Copy. Never hidden from the card: this is where
 * the agent can be turned on for the profile.
 */
function NotUsedLine({ runtime, name, strings }: { runtime: string; name: string; strings: CardStrings }) {
  const command = LOGIN_COMMANDS[runtime] ?? `${runtime} login`;
  const { button, status } = useCopy(command);
  return (
    <div data-usage-account={runtime} data-usage-not-used className="flex h-9 items-center gap-2 px-4 text-[12px] text-text-faint">
      <AgentMark runtime={runtime} size={18} className="opacity-60" />
      <span className="shrink-0 text-muted-foreground">{name}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{strings.notUsed}</span>
      <span aria-hidden="true">·</span>
      <code className="selectable-content min-w-0 flex-1 truncate font-mono">{command}</code>
      {button}
      {status}
    </div>
  );
}
