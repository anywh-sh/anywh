import { ArrowUpRight } from "lucide-react";
import { CommandLine } from "@/components/firstrun/CommandLine";
import { QuietLink } from "@/components/firstrun/QuietLink";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import { failureActions, type LocalFailureAction, type PreparingFailureCode } from "@/lib/install/localInstall";

/** Codes that name something the machine lacks — the reader can add it —
 * as opposed to an install that stopped. They pick the screen's title. */
const MISSING: ReadonlySet<PreparingFailureCode> = new Set<PreparingFailureCode>([
  "node_missing",
  "node_old",
  "brew_missing",
  "no_user_systemd",
  "containerized",
  "relay_running",
  "relay_host_undetectable",
  "unsupported_arch",
]);

export function isMissingFailure(code: PreparingFailureCode): boolean {
  return MISSING.has(code);
}

/**
 * The box inside the preparing card when something stopped: the sentence
 * for the code, the command or page that fixes it when there is one, and
 * the ways forward (`failureActions`), the first one primary. Which action
 * does what is the screen's business — this only draws them.
 */
export function PreparingFailure({
  code,
  actions = failureActions(code),
  onAction,
}: {
  code: PreparingFailureCode;
  actions?: LocalFailureAction[];
  onAction: (action: LocalFailureAction) => void;
}) {
  const copy = useDict().firstRun.preparing.fail;
  const entry = copy.codes[code];

  return (
    <div role="alert" className="flex flex-col gap-3.5 border-t border-border-soft px-4 py-4">
      <p className="text-[13.5px] leading-[1.65] text-pretty text-foreground">{entry.body}</p>
      {entry.command && <CommandLine command={entry.command} />}
      {entry.link && (
        <QuietLink href={entry.link.href} className="self-start">
          {entry.link.label}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </QuietLink>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => (
          <Button key={action} type="button" variant={index === 0 ? "default" : "outline"} onClick={() => onAction(action)}>
            {copy.actions[action]}
          </Button>
        ))}
      </div>
    </div>
  );
}
