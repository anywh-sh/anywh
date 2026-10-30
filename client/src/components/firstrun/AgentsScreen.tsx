import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import {
  AgentCard,
  cardModelFromInfo,
  type AgentCardModel,
} from "@/components/firstrun/AgentCard";
import { OnboardingFrame } from "@/components/firstrun/OnboardingFrame";
import { QuietLink } from "@/components/firstrun/QuietLink";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import {
  AGENTS_TIMEOUT_MS,
  agentCardState,
  fetchAgentsCatalog,
  isSelectable,
  preselectedAgent,
  withTimeout,
  type AgentInfo,
} from "@/lib/install/agentsCatalog";
import {
  clearPendingAgents,
  setPendingAgents,
} from "@/lib/install/pendingAgents";
import { finishFirstRun } from "@/lib/profiles/firstRun";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import {
  findProfile,
  getProfiles,
  setProfiles,
  type Profile,
} from "@/lib/profiles/profiles";
import { updateProfileMeta } from "@/lib/relay/relayClient";

/** What the cards show before the relay has answered: the agents anywh
 * knows, in the relay's registry order. */
const KNOWN_AGENT_IDS = ["claude", "codex"] as const;

type Load =
  | { phase: "checking" }
  | { phase: "failed" }
  | { phase: "loaded"; agents: AgentInfo[]; full: boolean };

/**
 * The last step of the first run: which agents the relay found on the
 * machine, and which one opens by default. "Start" is open as soon as one
 * agent is installed, signed in or not — a missing login is shown (with the
 * command to run), never a gate. The choice is saved as the profile's fixed
 * default agent; a new session only starts on it, it can still be switched
 * per session.
 *
 * `remoteHost` is set when the profile is another machine's (the screen then
 * names it instead of "this machine"). Detection is the relay's, redone on
 * every call; "Check again" is the one control that asks again.
 */
export function AgentsScreen({
  profile,
  remoteHost,
  onOtherMachine,
  onBack,
}: {
  profile: Profile;
  remoteHost?: string;
  onOtherMachine: () => void;
  onBack?: () => void;
}) {
  const dict = useDict();
  const copy = dict.firstRun.agents;
  const frame = dict.firstRun.frame;
  const names = dict.chat.composer.agentNames;
  const groupName = useId();
  const [load, setLoad] = useState<Load>({ phase: "checking" });
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const request = useRef(0);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  /** Drops whatever answer is still on its way. */
  const cancel = useCallback(() => {
    request.current++;
  }, []);

  const check = useCallback(() => {
    const mine = ++request.current;
    setLoad({ phase: "checking" });
    withTimeout(fetchAgentsCatalog(profileRef.current), AGENTS_TIMEOUT_MS).then(
      (catalog) => {
        if (mine !== request.current) return;
        setLoad({
          phase: "loaded",
          agents: catalog.agents,
          full: catalog.full,
        });
        setSelected((current) =>
          current !== null &&
          catalog.agents.some((a) => a.id === current && isSelectable(a))
            ? current
            : (preselectedAgent(catalog.agents)?.id ?? null),
        );
      },
      () => {
        if (mine === request.current) setLoad({ phase: "failed" });
      },
    );
  }, []);

  useEffect(() => {
    setPendingAgents(profile.id);
    check();
    return cancel;
  }, [profile.id, check, cancel]);

  const where = remoteHost ? copy.at.replace("{host}", remoteHost) : copy.here;
  const scope = remoteHost
    ? copy.scopeAt.replace("{host}", remoteHost)
    : copy.scopeHere;
  const agents = load.phase === "loaded" ? load.agents : [];
  const installed = agents.filter(isSelectable);
  const choosing = installed.length >= 2;
  const checking = load.phase === "checking";
  const chosen = installed.find((a) => a.id === selected) ?? null;
  const chosenName = chosen
    ? (names[chosen.id as KnownAgentId] ?? chosen.id)
    : null;

  const cards: AgentCardModel[] = checking
    ? KNOWN_AGENT_IDS.map((id) => ({
        id,
        bin: id,
        state: "checking",
        version: null,
        loginCommand: null,
        installUrl: null,
        docsUrl: null,
      }))
    : agents.map((a) => cardModelFromInfo(a, agentCardState(a)));

  async function start(): Promise<void> {
    if (!chosen || starting) return;
    setStarting(true);
    const preference = { mode: "fixed", fixedAgentId: chosen.id } as const;
    try {
      // Bounded: an unreachable machine must not hold "Start" for the
      // OS connect timeout when the choice is kept here regardless.
      await withTimeout(
        resolveConnection(profile).then(({ host, port, token }) => updateProfileMeta(host, port, profile.id, { agentPreference: preference }, token)),
        AGENTS_TIMEOUT_MS,
      );
    } catch {
      // An older relay answers 400 and an unreachable one throws: neither
      // blocks the first run. The choice is kept on this device either way.
    }
    if (findProfile(profile.id))
      setProfiles(
        getProfiles().map((p) =>
          p.id === profile.id ? { ...p, agentPreference: preference } : p,
        ),
      );
    clearPendingAgents();
    finishFirstRun(profile.id);
  }

  const title = checking
    ? copy.searching
    : load.phase === "failed"
      ? copy.title
      : installed.length === 0
        ? copy.none
        : copy.title;
  const body = checking
    ? copy.searchingBody
    : load.phase === "failed"
      ? copy.failed
      : installed.length === 0
        ? copy.bodyNone
        : choosing
          ? copy.bodyMany
          : copy.bodyOne;

  // The one "Check again" on the screen: beside the list's label when there
  // is something to look at, under it when there is nothing to start with.
  const recheck = (
    <button
      type="button"
      onClick={check}
      disabled={checking}
      className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline disabled:cursor-default disabled:opacity-50"
    >
      <RefreshCw className="size-3" aria-hidden="true" />
      {copy.recheck}
    </button>
  );
  const nothingToStart = !checking && installed.length === 0;

  return (
    <OnboardingFrame
      onBack={onBack}
      steps={[
        {
          id: "machine",
          label: remoteHost
            ? frame.steps.otherMachine
            : frame.steps.thisMachine,
        },
        { id: "agents", label: frame.steps.agents },
      ]}
      current="agents"
    >
      <section className="flex flex-col gap-3">
        <h1 className="font-display text-[32px] leading-[1.15] font-bold tracking-[-0.035em] text-balance text-foreground">
          {title}
        </h1>
        <p
          aria-live="polite"
          className="max-w-[60ch] text-[15px] leading-[1.7] text-pretty text-muted-foreground"
        >
          {body.replace("{where}", where).replace("{count}", String(installed.length))}
        </p>
      </section>

      {cards.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex min-h-5 items-center justify-between">
            <span className="font-mono text-[11.5px] text-text-faint">
              {scope}
            </span>
            {!nothingToStart && recheck}
          </div>
          <ul
            role={choosing ? "radiogroup" : undefined}
            aria-label={choosing ? copy.title : undefined}
            className="flex flex-col gap-2"
          >
            {cards.map((card) => (
              <AgentCard
                key={card.id}
                agent={card}
                choice={
                  choosing &&
                  card.state !== "missing" &&
                  card.state !== "checking"
                    ? {
                        name: groupName,
                        checked: card.id === selected,
                        onSelect: () => setSelected(card.id),
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        </section>
      )}

      {nothingToStart || load.phase === "failed" ? (
        <section className="flex flex-wrap items-center gap-4">
          {recheck}
          <QuietLink onClick={onOtherMachine}>{copy.otherMachine}</QuietLink>
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-4">
          <Button
            type="button"
            size="lg"
            disabled={!chosen || starting}
            onClick={() => void start()}
            className="gap-2"
          >
            {chosenName
              ? copy.startWith.replace("{agent}", chosenName)
              : copy.start}
            <ArrowRight aria-hidden="true" />
          </Button>
          {choosing && (
            <p className="font-mono text-[11.5px] text-text-faint">
              {copy.switchNote}
            </p>
          )}
          {/* While the answer is on its way the way out stays: a machine
           * that never answers must not hold the reader here. */}
          {checking && <QuietLink onClick={onOtherMachine}>{copy.otherMachine}</QuietLink>}
        </section>
      )}
    </OnboardingFrame>
  );
}
