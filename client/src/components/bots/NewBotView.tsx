import { useEffect, useRef, useState } from "react";
import { ArrowRight, CalendarClock, ChevronLeft, ChevronRight, Dices, Lock, MessageSquare, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { RowButton } from "@/components/ui/row-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Segmented } from "@/components/ui/segmented";
import { TextButton } from "@/components/ui/text-button";
import { Mascot } from "@/components/bots/Mascot";
import { BotsRelayGate } from "@/components/bots/BotsRelayGate";
import { useHostAgents, agentName } from "@/components/chat/AgentModelEffortButton";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { Switch } from "@/components/ui/switch";
import { lacksFeature, useRelayFeatures } from "@/hooks/relay/useRelayFeatures";
import { useDict } from "@/i18n";
import { BotRequestError, createBot } from "@/lib/bots/botClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { getBots } from "@/lib/bots/botsStore";
import { rerollSeed } from "@/lib/bots/mascot";
import { BOT_TEMPLATES, type BotTemplate } from "@/lib/bots/templates";
import { profileColorClass, type Profile } from "@/lib/profiles/profiles";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { cn } from "@/lib/utils";

/** The intro's dot grid: the room canvas's `--canvas-grid` dots, faded toward
 * the edges (under it, the new-session line grid, `.idle-grid`). */
const DOT_GRID_STYLE = {
  backgroundImage: "radial-gradient(circle, var(--canvas-grid) 1px, transparent 1.5px)",
  backgroundSize: "24px 24px",
  maskImage: "radial-gradient(ellipse at center, black 30%, transparent 85%)",
} as const;

/** Agents a bot can run on: the ones a room can (the agent host runs them). */
const BOT_RUNTIMES = ["claude", "codex"];

interface NewBotViewProps {
  profile: Profile;
  /** The bot exists (on `profile`, the one picked): the tab becomes its
   * conversation. */
  onCreated: (bot: BotSummary, profile: Profile) => void;
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
export function NewBotView({ profile: tabProfile, onCreated, agents: givenAgents }: NewBotViewProps) {
  const dict = useDict();
  const copy = dict.bots.create;
  // A profile with no bot yet opens on a presentation; one that has bots goes
  // straight to the templates.
  const [step, setStep] = useState<"intro" | 1 | 2>(() => (getBots(tabProfile.id).length === 0 ? "intro" : 1));
  // Where the bot will live: the tab's profile unless the person picks another.
  const profiles = useProfiles();
  const [profileId, setProfileId] = useState(tabProfile.id);
  const profile = profiles.find((each) => each.id === profileId) ?? tabProfile;
  const purposeRef = useRef<HTMLInputElement>(null);
  const [purpose, setPurpose] = useState("");
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  const [focusedTemplate, setFocusedTemplate] = useState<BotTemplate>(BOT_TEMPLATES[0]);
  const [name, setName] = useState("");
  const [soul, setSoul] = useState("");
  // The face the person drew with "draw another": kept as is from then on, so
  // typing the name no longer changes it.
  const [drawnSeed, setDrawnSeed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scheduleOn, setScheduleOn] = useState(false);
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
  // scratch takes its face from its name, until the person draws one.
  const seedBase = template?.seed ?? (name.trim() || "bot");
  const seed = drawnSeed ?? seedBase;
  const drawAnother = (): void => {
    const next = attempt + 1;
    setAttempt(next);
    setDrawnSeed(rerollSeed(seedBase, next));
  };

  const startFrom = (picked: BotTemplate | null): void => {
    setTemplate(picked);
    setDrawnSeed(null);
    setAttempt(0);
    setScheduleOn(false);
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
        ...(template && words ? { templateId: template.id, schedules: [{ name: words.scheduleName, cron: template.cron, prompt: template.prompt, paused: !scheduleOn }] } : {}),
      });
      onCreated(bot, profile);
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

  if (step === "intro") {
    return (
      <Intro
        onTemplates={(picked) => {
          if (picked) setFocusedTemplate(picked);
          setStep(1);
        }}
        onScratch={() => {
          setStep(1);
          requestAnimationFrame(() => purposeRef.current?.focus());
        }}
      />
    );
  }

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
              <form
                className="flex items-center gap-2 border border-border bg-bg-chrome py-1.5 pr-1.5 pl-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (purpose.trim() !== "") startFrom(null);
                }}
              >
                <Input
                  ref={purposeRef}
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder={copy.describePlaceholder}
                  className="h-9 flex-1 border-0 bg-transparent px-0 font-sans text-sm focus-visible:ring-0"
                  aria-label={copy.step1}
                />
                <Button type="submit" variant="outline" size="sm" disabled={purpose.trim() === ""}>
                  {copy.fromScratch}
                  <ChevronRight />
                </Button>
              </form>
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
                <Button variant="outline" size="sm" onClick={drawAnother}>
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
                    <Segmented id="new-bot-agent" kind="radio" label={copy.agent} value={agentId} onChange={setAgentId} options={agents.map((id) => ({ value: id, label: agentName(dict.chat.composer.agentNames, id), icon: <AgentLogo agentId={id} className="size-3.5 shrink-0" /> }))} />
                  </div>
                )}
                {profiles.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[11px] text-text-faint">{copy.profile}</span>
                    <div className="flex flex-col border border-border" role="radiogroup" aria-label={copy.profile}>
                      {profiles.map((each) => (
                        <RowButton
                          key={each.id}
                          role="radio"
                          aria-checked={each.id === profile.id}
                          selected={each.id === profile.id}
                          onClick={() => setProfileId(each.id)}
                          className="gap-2.5 border-b border-border px-3 last:border-b-0"
                        >
                          <span aria-hidden className={cn("size-2 shrink-0", profileColorClass(each.id))} />
                          <span className="flex-1 truncate">{each.label}</span>
                          <span className="font-mono text-[11px] text-text-faint">{each.host}</span>
                        </RowButton>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-text-faint">{copy.startsWith}</span>
                  <div className="flex flex-col border border-border">
                    <div className="flex items-start gap-2.5 px-3 py-2.5">
                      <Lock className="mt-0.5 size-3.5 shrink-0 text-text-faint" />
                      <span className="flex flex-col gap-0.5">
                        <span className="text-[13px] text-foreground">{copy.readOnly}</span>
                        <span className="text-[11px] text-text-faint">{copy.readOnlyHint}</span>
                      </span>
                    </div>
                    {template && (
                      <label className="flex cursor-pointer items-center gap-2.5 border-t border-border px-3 py-2.5">
                        <CalendarClock className="size-3.5 shrink-0 text-text-faint" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-[13px] text-foreground">{dict.bots.templates[template.id].scheduleName}</span>
                          <span className="font-mono text-[11px] text-text-faint">{scheduleOn ? dict.bots.templates[template.id].when : copy.schedulesOff}</span>
                        </span>
                        <Switch checked={scheduleOn} onCheckedChange={setScheduleOn} aria-label={dict.bots.templates[template.id].scheduleName} />
                      </label>
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
            <>
              <p className="hidden items-center gap-2 font-mono text-[11px] text-text-faint lg:flex">
                <Lock className="size-3 shrink-0" />
                {copy.readOnly}
              </p>
              <p className="mb-2 hidden items-center gap-2 font-mono text-[11px] text-text-faint lg:flex">
                <CalendarClock className="size-3 shrink-0" />
                {copy.schedulesOff}
              </p>
              <Button onClick={() => startFrom(focusedTemplate)}>
                {copy.useTemplate}
                <ArrowRight />
              </Button>
            </>
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

/**
 * What a bot is, for a profile that has none yet: the faces of the
 * templates, three lines on how bots work, a few templates to start from, and
 * the two ways in (all the templates, or from scratch).
 */
function Intro({ onTemplates, onScratch }: { onTemplates: (picked?: BotTemplate) => void; onScratch: () => void }) {
  const dict = useDict();
  const copy = dict.bots.create.intro;
  const features = [
    { icon: <MessageSquare className="size-3.5" />, title: copy.anywhere, body: copy.anywhereBody },
    { icon: <Network className="size-3.5" />, title: copy.delegates, body: copy.delegatesBody },
    { icon: <span className="mx-1 block size-1.5 rounded-full bg-primary" />, title: copy.quiet, body: copy.quietBody },
  ];
  return (
    <div className="relative h-full overflow-auto" data-testid="new-bot-view">
      <div aria-hidden className="idle-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={DOT_GRID_STYLE} />
      <div className="relative flex min-h-full items-center justify-center px-10 py-12" data-testid="new-bot-intro">
        <div className="flex w-full max-w-[680px] flex-col items-center gap-6 text-center">
          <div className="flex items-end gap-4" aria-hidden>
            {BOT_TEMPLATES.map((each) => (
              <Mascot key={each.id} seed={each.seed} size={40} />
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <h1 className="text-[28px] leading-tight font-semibold text-foreground">{copy.title}</h1>
            <p className="mx-auto max-w-[540px] text-sm leading-relaxed text-muted-foreground">{dict.bots.emptyBody}</p>
          </div>
          <div className="grid w-full grid-cols-1 border border-border bg-background text-left md:grid-cols-3">
            {features.map((each) => (
              <div key={each.title} className="flex flex-col gap-1.5 border-border p-4 not-last:border-b md:not-last:border-r md:not-last:border-b-0">
                <span className="flex h-3.5 items-center text-muted-foreground">{each.icon}</span>
                <span className="text-[13px] font-medium text-foreground">{each.title}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{each.body}</span>
              </div>
            ))}
          </div>
          <div className="grid w-full grid-cols-1 gap-2 text-left md:grid-cols-3">
            {BOT_TEMPLATES.slice(0, 3).map((each) => {
              const words = dict.bots.templates[each.id];
              return (
                <RowButton key={each.id} size="auto" onClick={() => onTemplates(each)} className="gap-2.5 border border-border bg-background p-3 hover:bg-surface-hover">
                  <Mascot seed={each.seed} size={20} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] text-foreground">{words.name}</span>
                    <span className="truncate font-mono text-[10.5px] text-text-faint">{words.when}</span>
                  </span>
                </RowButton>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => onTemplates()}>
              {copy.seeTemplates.replace("{count}", String(BOT_TEMPLATES.length))}
              <ArrowRight />
            </Button>
            <Button variant="outline" onClick={onScratch}>
              {dict.bots.create.fromScratch}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
