import { useEffect, useState } from "react";
import { CalendarClock, Dices, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { RowButton } from "@/components/ui/row-button";
import { Segmented } from "@/components/ui/segmented";
import { Mascot } from "@/components/bots/Mascot";
import { useHostAgents, agentName } from "@/components/chat/AgentModelEffortButton";
import { useDict } from "@/i18n";
import { BotRequestError, createBot } from "@/lib/bots/botClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { rerollSeed } from "@/lib/bots/mascot";
import { BOT_TEMPLATES, type BotTemplate } from "@/lib/bots/templates";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

/** Agents a bot can run on: the ones a room can (the agent host runs them). */
const BOT_RUNTIMES = ["claude", "codex"];

interface NewBotDialogProps {
  profile: Profile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bot exists: the caller opens its conversation. */
  onCreated: (bot: BotSummary) => void;
  /** The agents to offer, instead of asking the relay (the stories). */
  agents?: string[];
}

/**
 * Creating a bot, in two steps: what it should do (the person's own words, or
 * a template), then who it is (name, mascot, soul, agent). A template's
 * schedule is created off, and its soul starts with a "Never" section: a new
 * bot reads and reports until the person says otherwise.
 */
export function NewBotDialog({ profile, open, onOpenChange, onCreated, agents: givenAgents }: NewBotDialogProps) {
  const dict = useDict();
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
  const hostAgents = useHostAgents(profile, open && givenAgents === undefined);
  const agents = (givenAgents ?? hostAgents).filter((id) => BOT_RUNTIMES.includes(id));

  // Every opening starts over.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setPurpose("");
    setTemplate(null);
    setName("");
    setSoul("");
    setAttempt(0);
    setBusy(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (agents.length > 0 && !agents.includes(agentId)) setAgentId(agents[0]);
  }, [agents, agentId]);

  const seedBase = name.trim() || template?.seed || "bot";
  const seed = rerollSeed(seedBase, attempt);

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
      onOpenChange(false);
      onCreated(bot);
    } catch (caught) {
      setError(caught instanceof BotRequestError && caught.status === 503 ? dict.bots.create.noHost : dict.bots.create.failed);
      setBusy(false);
    }
  };

  const focusedWords = dict.bots.templates[focusedTemplate.id];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="new-bot-dialog">
        <DialogHeader>
          <DialogTitle>
            {dict.bots.create.title} · {step}/2
          </DialogTitle>
        </DialogHeader>
        {step === 1 ? (
          <DialogBody className="gap-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-lg font-medium text-foreground">{dict.bots.create.step1}</h3>
              <p className="text-sm text-muted-foreground">{dict.bots.create.step1Body}</p>
            </div>
            <div className="flex gap-2">
              <Input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder={dict.bots.create.describePlaceholder} className="flex-1" aria-label={dict.bots.create.step1} />
              <Button variant="outline" disabled={purpose.trim() === ""} onClick={() => startFrom(null)}>
                {dict.bots.create.fromScratch}
              </Button>
            </div>
            <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.orTemplate}</span>
            <div className="grid gap-4 sm:grid-cols-[1fr_260px]">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {BOT_TEMPLATES.map((each) => {
                  const words = dict.bots.templates[each.id];
                  return (
                    <RowButton
                      key={each.id}
                      size="auto"
                      selected={focusedTemplate.id === each.id}
                      onClick={() => setFocusedTemplate(each)}
                      onDoubleClick={() => startFrom(each)}
                      className="items-start gap-2.5 border border-border p-2.5 hover:bg-surface-hover"
                    >
                      <Mascot seed={each.seed} size={24} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[13px] text-foreground">{words.name}</span>
                        <span className="font-mono text-[10.5px] text-text-faint">{words.when}</span>
                        <span className="text-xs leading-snug text-muted-foreground">{words.line}</span>
                      </span>
                    </RowButton>
                  );
                })}
              </div>
              <div className="flex flex-col gap-3 border border-border p-3" data-testid="template-preview">
                <Mascot seed={focusedTemplate.seed} size={48} />
                <span className="text-base font-medium text-foreground">{focusedWords.name}</span>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="font-mono text-text-faint">{dict.bots.create.watches}</dt>
                  <dd className="text-foreground/90">{focusedWords.watches}</dd>
                  <dt className="font-mono text-text-faint">{dict.bots.create.does}</dt>
                  <dd className="text-foreground/90">{focusedWords.does}</dd>
                  <dt className="font-mono text-text-faint">{dict.bots.create.reports}</dt>
                  <dd className="text-foreground/90">{focusedWords.reports}</dd>
                </dl>
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.example}</span>
                  <p className="border border-border p-2 text-xs leading-relaxed text-foreground/90">{focusedWords.example}</p>
                </div>
                <Button onClick={() => startFrom(focusedTemplate)}>{dict.bots.create.useTemplate}</Button>
              </div>
            </div>
          </DialogBody>
        ) : (
          <>
            <DialogBody className="gap-4">
              <h3 className="text-lg font-medium text-foreground">{dict.bots.create.step2}</h3>
              <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
                <div className="flex flex-col items-center gap-2">
                  <span className="self-start font-mono text-[11px] text-text-faint">{dict.bots.create.mascot}</span>
                  <div className="flex size-[120px] items-center justify-center border border-border">
                    <Mascot seed={seed} size={96} title={name || undefined} />
                  </div>
                  <Button variant="outline" size="xs" onClick={() => setAttempt((n) => n + 1)}>
                    <Dices />
                    {dict.bots.create.reroll}
                  </Button>
                </div>
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.name}</span>
                    <Input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.soul}</span>
                    <Textarea value={soul} rows={6} onChange={(event) => setSoul(event.target.value)} />
                    <span className="text-[11px] text-text-faint">{dict.bots.create.soulHint}</span>
                  </label>
                  {agents.length > 1 && (
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.agent}</span>
                      <Segmented id="new-bot-agent" kind="radio" label={dict.bots.create.agent} value={agentId} onChange={setAgentId} options={agents.map((id) => ({ value: id, label: agentName(dict.chat.composer.agentNames, id) }))} />
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.startsWith}</span>
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Lock className="size-3 shrink-0" />
                      {dict.bots.create.readOnly}
                    </p>
                    {template && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <CalendarClock className="size-3 shrink-0" />
                        {dict.bots.create.schedulesOff}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(1)} disabled={busy}>
                {dict.bots.create.back}
              </Button>
              <Button loading={busy} disabled={name.trim() === "" || soul.trim() === ""} onClick={() => void create()} className={cn(busy && "pointer-events-none")}>
                {busy ? dict.bots.create.creating : dict.bots.create.create.replace("{name}", name.trim() || "bot")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

