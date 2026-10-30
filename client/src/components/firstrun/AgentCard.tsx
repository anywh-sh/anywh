import { useId } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { CommandLine } from "@/components/firstrun/CommandLine";
import { QuietLink } from "@/components/firstrun/QuietLink";
import { Spinner } from "@/components/firstrun/Spinner";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import type { AgentCardState, AgentInfo } from "@/lib/install/agentsCatalog";
import { cn } from "@/lib/utils";

/** What a card draws for an agent the relay hasn't answered about yet. */
export interface AgentCardModel {
  id: string;
  bin: string;
  state: AgentCardState;
  version: string | null;
  loginCommand: string | null;
  installUrl: string | null;
  docsUrl: string | null;
}

export function cardModelFromInfo(info: AgentInfo, state: AgentCardState): AgentCardModel {
  return {
    id: info.id,
    bin: info.bin,
    state,
    version: info.version,
    loginCommand: info.loginCommand,
    installUrl: info.installUrl,
    docsUrl: info.docsUrl,
  };
}

/**
 * One agent, as the "Your agents" screen shows it: a mark, the name, what the
 * relay found (`bin · vX.Y.Z`) and one of four states. Ready is green
 * (`--diff-add`); No login keeps the accent dot and shows the command to
 * copy, never runs it; Not found is a hollow card with the way to install.
 *
 * `choice` makes the card a radio of the group named `name`; without it the
 * card is just a row. The radio is a real input hidden behind the card, so
 * the group has native keyboard handling and the card carries the focus ring.
 */
export function AgentCard({ agent, choice }: { agent: AgentCardModel; choice?: { name: string; checked: boolean; onSelect: () => void } }) {
  const dict = useDict();
  const copy = dict.firstRun.agents;
  const agentName = dict.chat.composer.agentNames[agent.id as KnownAgentId] ?? agent.id;
  const missing = agent.state === "missing";
  const describedBy = useId();

  const meta =
    agent.state === "checking"
      ? `${agent.bin} · ${copy.meta.searching}`
      : missing
        ? `${agent.bin} · ${copy.meta.notOnPath}`
        : agent.version
          ? `${agent.bin} · v${agent.version.replace(/^v/, "")}`
          : agent.bin;

  const head = (
    <div className="flex items-center gap-4">
      <span className={cn("flex size-8 shrink-0 items-center justify-center text-foreground", missing && "opacity-50")}>
        <AgentLogo agentId={agent.id} className="size-6" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-[length:calc(15px*var(--font-scale-ratio))] font-medium", missing ? "text-muted-foreground" : "text-foreground")}>{agentName}</span>
        <span id={`${describedBy}-meta`} className="truncate font-mono text-[length:calc(11.5px*var(--font-scale-ratio))] text-text-faint">
          {meta}
        </span>
      </div>
      <StateLabel id={`${describedBy}-state`} state={agent.state} />
    </div>
  );

  return (
    <li
      data-state={agent.state}
      className={cn(
        "flex flex-col gap-3 border p-4 has-focus-visible:ring-2 has-focus-visible:ring-ring/50",
        missing ? "border-border-soft bg-transparent" : "border-border-soft bg-bg-chrome",
        choice?.checked && "border-foreground/40 bg-card",
      )}
    >
      {choice ? (
        <label className="flex cursor-pointer items-center gap-4">
          <input
            type="radio"
            name={choice.name}
            checked={choice.checked}
            onChange={choice.onSelect}
            aria-label={agentName}
            // The name alone is the radio's label; what was found and its
            // state ("No login") are read as its description.
            aria-describedby={`${describedBy}-meta ${describedBy}-state`}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border peer-checked:border-foreground peer-checked:after:size-2 peer-checked:after:rounded-full peer-checked:after:bg-foreground"
          />
          <div className="min-w-0 flex-1">{head}</div>
        </label>
      ) : (
        head
      )}

      {agent.state === "noLogin" && (
        <div className="flex flex-col gap-2.5 sm:pl-12">
          <p className="max-w-[60ch] text-[length:calc(13px*var(--font-scale-ratio))] leading-[1.6] text-pretty text-muted-foreground">{copy.noLoginHint}</p>
          {agent.loginCommand && <CommandLine command={agent.loginCommand} />}
        </div>
      )}
      {missing && (agent.installUrl || agent.docsUrl) && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 sm:pl-12">
          {agent.installUrl && (
            <QuietLink href={agent.installUrl} className="text-foreground">
              {copy.howToInstall.replace("{agent}", agentName)}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </QuietLink>
          )}
          {agent.docsUrl && (
            <QuietLink href={agent.docsUrl}>
              {copy.installDocs}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </QuietLink>
          )}
        </div>
      )}
    </li>
  );
}

function StateLabel({ id, state }: { id: string; state: AgentCardState }) {
  const label = useDict().firstRun.agents.state[state];
  return (
    <span id={id} className="flex shrink-0 items-center gap-2 font-mono text-[length:calc(12px*var(--font-scale-ratio))]">
      {state === "ready" && <Check className="size-3.5 text-diff-add" aria-hidden="true" />}
      {state === "noLogin" && <span aria-hidden="true" className="size-2 rounded-full bg-primary" />}
      {state === "missing" && <span aria-hidden="true" className="size-2 border border-text-faint" />}
      {state === "checking" && <Spinner />}
      <span className={cn(state === "ready" ? "text-diff-add" : state === "noLogin" ? "text-foreground" : "text-text-faint")}>{label}</span>
    </span>
  );
}
