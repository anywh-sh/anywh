import { useEffect, useState } from "react";
import { CalendarClock, ChevronLeft, Dices, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { RowButton } from "@/components/ui/row-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Segmented } from "@/components/ui/segmented";
import { TextButton } from "@/components/ui/text-button";
import { Mascot } from "@/components/bots/Mascot";
import { BotsRelayGate } from "@/components/bots/BotsRelayGate";
import { useHostAgents, agentName } from "@/components/chat/AgentModelEffortButton";
import { lacksFeature, useRelayFeatures } from "@/hooks/relay/useRelayFeatures";
import { useDict } from "@/i18n";
import { BotRequestError, createBot } from "@/lib/bots/botClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { rerollSeed } from "@/lib/bots/mascot";
import { BOT_TEMPLATES, type BotTemplate } from "@/lib/bots/templates";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

/** Agents a bot can run on: the ones a room can (the agent host runs them). */
const BOT_RUNTIMES = ["claude", "codex"];

interface NewBotViewProps {
  profile: Profile;
  /** The bot exists: the tab becomes its conversation. */
  onCreated: (bot: BotSummary) => void;
  /** The agents to offer, instead of asking the relay (the stories). */
  agents?: string[];
}

/**
 * Creating a bot, as a tab of its own: what it should do (the person's own
 * words, or a template), then who it is (name, mascot, soul, agent). The page
 * fills the tab, with a column on the right that previews the choice: the
 * template picked, then the bot as the sidebar will show it. A template's
 * schedule is created off, and its soul starts with a "Never" section: a new
 * bot reads and reports until the person says otherwise.
 */
export function NewBotView({ profile, onCreated, agents: givenAgents }: NewBotViewProps) {
  const dict = useDict();
  const copy = dict.bots.create;
  const [step, setStep] = useState<1 | 2>(1);
  const [purpose, setPurpose] = useState("");
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  const [focusedTemplate, setFocusedTemplate] = useState<BotTemplate>(BOT_TEMPLATES[0]);
  const [name, setName] = useState("");
  const [soul, setSoul] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [agentId, setAgentId] = useState("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostAgents = useHostAgents(profile, givenAgents === undefined);
  const agents = (givenAgents ?? hostAgents).filter((id) => BOT_RUNTIMES.includes(id));
  const relay = useRelayFeatures(profile, "bots");

  useEffect(() => {
    if (agents.length > 0 && !agents.includes(agentId)) setAgentId(agents[0]);
  }, [agents, agentId]);

  // A template keeps its own face whatever it is renamed to; a bot from
  // scratch takes its face from its name.
  const seed = rerollSeed(template?.seed ?? (name.trim() || "bot"), attempt);

  const startFrom = (picked: BotTemplate | null): void => {
    setTemplate(picked);
    if (picked) {
      const words = dict.bots.templates[picked.id];
      setName(words.name);
      setSoul(words.soul);
    } else {
      setName("");
      setSoul(dict.bots.blankSoul.replace("{purpose}", purpose.trim()));
    }
    setError(null);
    setStep(2);
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const words = template ? dict.bots.templates[template.id] : undefined;
      const bot = await createBot(profile, {
        name: name.trim(),
        soul: soul.trim(),
        mascotSeed: seed,
        agentId,
        ...(template && words ? { templateId: template.id, schedules: [{ name: words.scheduleName, cron: template.cron, prompt: template.prompt, paused: true }] } : {}),
      });
      onCreated(bot);
    } catch (caught) {
      setError(caught instanceof BotRequestError && caught.status === 503 ? copy.noHost : copy.failed);
      setBusy(false);
    }
  };

  if (lacksFeature(relay, "bots")) {
    return (
      <div className="flex h-full items-start justify-center overflow-auto px-10 py-12" data-testid="new-bot-view">
        <div className="w-full max-w-md border border-border">
          <BotsRelayGate profile={profile} relayVersion={relay.version} />
        </div>
      </div>
    );
  }

  const focusedWords = dict.bots.templates[focusedTemplate.id];
  const stepLabel = copy.stepOf.replace("{step}", String(step));

  return (
    // Narrow, the preview column folds to a bar under the page holding just
    // the step's action.
    <div className="flex h-full min-h-0 flex-col lg:flex-row" data-testid="new-bot-view">
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex max-w-[760px] flex-col gap-6 px-10 pt-10 pb-12">
          {step === 2 && (
            <TextButton onClick={() => setStep(1)} disabled={busy} className="-ml-1 flex w-fit items-center gap-1 text-[13px]">
              <ChevronLeft className="size-3.5" />
              {copy.templatesBack}
            </TextButton>
          )}
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] text-text-faint">{template && step === 2 ? `${stepLabel} · ${dict.bots.templates[template.id].name}` : stepLabel}</span>
            <h1 className="text-[26px] leading-tight font-semibold text-foreground">{step === 1 ? copy.step1 : copy.step2}</h1>
            {step === 1 && <p className="max-w-[560px] text-sm leading-relaxed text-muted-foreground">{copy.step1Body}</p>}
          </div>

          {step === 1 ? (
            <>
              <div className="flex gap-2 border border-border bg-bg-chrome p-2">
                <Input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder={copy.describePlaceholder} className="flex-1 border-transparent bg-transparent" aria-label={copy.step1} />
                <Button variant="outline" disabled={purpose.trim() === ""} onClick={() => startFrom(null)}>
                  {copy.fromScratch}
                </Button>
              </div>
              <div className="flex flex-col gap-3">
                <span className="font-mono text-[11px] text-text-faint">{copy.orTemplate}</span>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {BOT_TEMPLATES.map((each) => {
                    const words = dict.bots.templates[each.id];
                    return (
                      <RowButton
                        key={each.id}
                        size="auto"
                        selected={focusedTemplate.id === each.id}
                        onClick={() => setFocusedTemplate(each)}
                        onDoubleClick={() => startFrom(each)}
                        className="items-start gap-3 border border-border p-3 hover:bg-surface-hover"
                      >
                        <Mascot seed={each.seed} size={24} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[13px] text-foreground">{words.name}</span>
                          <span className="font-mono text-[10.5px] text-text-faint">{words.when}</span>
                          <span className="mt-1 text-xs leading-snug text-muted-foreground">{words.line}</span>
                        </span>
                      </RowButton>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="grid gap-6 md:grid-cols-[200px_1fr]">
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[11px] text-text-faint">{copy.mascot}</span>
                <div className="flex aspect-square w-full items-center justify-center border border-border bg-bg-chrome">
                  <Mascot seed={seed} size={96} title={name || undefined} />
                </div>
                <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  <Dices />
                  {copy.reroll}
                </Button>
              </div>
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-text-faint">{copy.name}</span>
                  <Input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-text-faint">{copy.soul}</span>
                  <Textarea value={soul} rows={8} onChange={(event) => setSoul(event.target.value)} />
                  <span className="text-[11px] text-text-faint">{copy.soulHint}</span>
                </label>
                {agents.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[11px] text-text-faint">{copy.agent}</span>
                    <Segmented id="new-bot-agent" kind="radio" label={copy.agent} value={agentId} onChange={setAgentId} options={agents.map((id) => ({ value: id, label: agentName(dict.chat.composer.agentNames, id) }))} />
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-text-faint">{copy.startsWith}</span>
                  <div className="flex flex-col border border-border">
                    <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                      <Lock className="size-3 shrink-0" />
                      {copy.readOnly}
                    </p>
                    {template && (
                      <p className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                        <CalendarClock className="size-3 shrink-0" />
                        {copy.schedulesOff}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </ScrollArea>

      <aside className="flex shrink-0 flex-col border-t border-border lg:w-[340px] lg:border-t-0 lg:border-l" data-testid="new-bot-preview">
        {step === 1 ? (
          <div className="hidden min-h-0 flex-1 flex-col gap-4 overflow-auto p-8 lg:flex" data-testid="template-preview">
            <Mascot seed={focusedTemplate.seed} size={72} />
            <div className="flex flex-col gap-1.5">
              <span className="text-lg font-semibold text-foreground">{focusedWords.name}</span>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{focusedWords.line}</p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="font-mono text-text-faint">{copy.watches}</dt>
              <dd className="text-foreground/90">{focusedWords.watches}</dd>
              <dt className="font-mono text-text-faint">{copy.does}</dt>
              <dd className="text-foreground/90">{focusedWords.does}</dd>
              <dt className="font-mono text-text-faint">{copy.reports}</dt>
              <dd className="text-foreground/90">{focusedWords.reports}</dd>
            </dl>
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] text-text-faint">{copy.example}</span>
              <div className="flex flex-col gap-2 border border-border p-3">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Mascot seed={focusedTemplate.seed} size={12} />
                  {focusedWords.name}
                </span>
                <p className="text-xs leading-relaxed text-foreground/90">{focusedWords.example}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="hidden min-h-0 flex-1 flex-col gap-2 overflow-auto p-8 lg:flex">
            <span className="font-mono text-[11px] text-text-faint">{copy.inSidebar}</span>
            <div className="flex items-center gap-2.5 border border-border bg-bg-sidebar px-3 py-2.5">
              <Mascot seed={seed} state="setup" size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] text-foreground">{name.trim() || "bot"}</span>
                <span className="truncate font-mono text-[11px] text-text-faint">{dict.bots.status.setup}</span>
              </span>
            </div>
          </div>
        )}
        <div className="flex shrink-0 flex-col gap-2 p-4 lg:border-t lg:border-border lg:p-6">
          {step === 1 ? (
            <Button onClick={() => startFrom(focusedTemplate)}>{copy.useTemplate}</Button>
          ) : (
            <>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button loading={busy} disabled={name.trim() === "" || soul.trim() === ""} onClick={() => void create()} className={cn(busy && "pointer-events-none")}>
                {busy ? copy.creating : copy.create.replace("{name}", name.trim() || "bot")}
              </Button>
            </>
          )}
        </div>
      </aside>

    </div>
  );
}
