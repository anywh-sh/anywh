import { useEffect, useRef, useState } from "react";
import { CalendarClock, LayoutGrid, Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { KbdShortcut } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TextButton } from "@/components/ui/text-button";
import { Mascot } from "@/components/bots/Mascot";
import { MASCOT_FRAME_STYLE, MascotPicker, mascotSummary } from "@/components/bots/MascotPicker";
import { BotsRelayGate } from "@/components/bots/BotsRelayGate";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { agentName, useHostAgents } from "@/components/chat/AgentModelEffortButton";
import { lacksFeature, useRelayFeatures } from "@/hooks/relay/useRelayFeatures";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useDict } from "@/i18n";
import { BotRequestError, createBot } from "@/lib/bots/botClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { defaultChoice, type MascotChoice } from "@/lib/bots/mascot";
import { closeNewBot, useNewBotRequest, type NewBotRequest } from "@/lib/bots/newBotRequest";
import { BOT_TEMPLATES } from "@/lib/bots/templates";
import { shortcutKeys } from "@/lib/platform/platform";
import { profileColorClass, type Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

/** Agents a bot can run on: the ones a room can (the agent host runs them). */
const BOT_RUNTIMES = ["claude", "codex"];

interface NewBotDialogProps {
  /** The bot exists, on `profile` (the one picked): open its conversation. */
  onCreated: (bot: BotSummary, profile: Profile, request: NewBotRequest) => void;
  /** "Start from a template": the templates tab of `profileId`. */
  onTemplates: (profileId: string) => void;
}

/**
 * "New bot", over whatever is on screen: its face, its name, who it is, the
 * agent it runs on and where. Opened from a template, everything comes
 * filled in; a template's bot starts reading and reporting only, and its
 * schedule off unless the person turns it on here. The app has one of these;
 * `openNewBot` opens it.
 */
export function NewBotDialog({ onCreated, onTemplates }: NewBotDialogProps) {
  const request = useNewBotRequest();
  // The last request stays drawn while the dialog closes, so its closing
  // animation has the form to fade out instead of an empty box.
  const [shown, setShown] = useState<NewBotRequest | null>(request);
  if (request !== null && request !== shown) setShown(request);
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && closeNewBot()}>
      {shown && (
        <DialogContent
          className="top-[92px] bottom-auto w-[600px] bg-bg-sidebar sm:max-w-[600px]"
          aria-describedby={undefined}
          data-slot="new-bot-dialog"
          data-testid="new-bot-dialog"
        >
          <NewBotForm
            // A new request starts from a clean form.
            key={`${shown.profileId}:${shown.templateId ?? ""}:${shown.fromTabId ?? ""}`}
            request={shown}
            onCreated={(bot, profile) => {
              closeNewBot();
              onCreated(bot, profile, shown);
            }}
            onTemplates={() => {
              closeNewBot();
              onTemplates(shown.profileId);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

/** The form itself, on its own for the stories. */
export function NewBotForm({
  request,
  onCreated,
  onTemplates,
  agents: givenAgents,
  profiles: givenProfiles,
}: {
  request: NewBotRequest;
  onCreated: (bot: BotSummary, profile: Profile) => void;
  onTemplates: () => void;
  /** The agents and profiles to offer instead of the app's (the stories). */
  agents?: string[];
  profiles?: Profile[];
}) {
  const dict = useDict();
  const copy = dict.bots.create;
  const template = BOT_TEMPLATES.find((each) => each.id === request.templateId);
  const words = template ? dict.bots.templates[template.id] : undefined;
  const storedProfiles = useProfiles();
  const profiles = givenProfiles ?? storedProfiles;
  const [profileId, setProfileId] = useState(request.profileId);
  // The dialog only opens from a profile, so there is always one to fall back on.
  const profile = profiles.find((each) => each.id === profileId) ?? profiles.find((each) => each.id === request.profileId) ?? profiles[0];
  const [name, setName] = useState(words?.name ?? "");
  const [soul, setSoul] = useState(words?.soul ?? "");
  const [mascot, setMascot] = useState<MascotChoice>(template?.mascot ?? defaultChoice("bip"));
  const [pickerOpen, setPickerOpen] = useState(false);
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

  const gated = lacksFeature(relay, "bots");
  const ready = name.trim() !== "" && soul.trim() !== "" && !busy && !gated;
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);

  // Disabling the form while it creates drops focus to the body (a disabled
  // control can't hold it); once a failed attempt unlocks it, focus goes back
  // to Create, so the next Tab stays in the dialog.
  useEffect(() => {
    if (error !== null && !busy) createButtonRef.current?.focus();
  }, [error, busy]);

  const create = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const bot = await createBot(profile, {
        name: name.trim(),
        // A bot from scratch gets the rule a template's soul already has:
        // nothing changes until the person says so.
        soul: template ? soul.trim() : dict.bots.blankSoul.replace("{soul}", soul.trim()),
        mascot,
        agentId,
        ...(template && words ? { templateId: template.id, schedules: [{ name: words.scheduleName, cron: template.cron, prompt: template.prompt, paused: !scheduleOn }] } : {}),
      });
      onCreated(bot, profile);
    } catch (caught) {
      setError(caught instanceof BotRequestError && caught.status === 503 ? copy.noHost : copy.failed);
      setBusy(false);
    }
  };

  // ⌘/Ctrl+Enter creates from anywhere in the dialog, not only from inside
  // the form: WebKit doesn't focus a button, switch or select it clicks, and a
  // click on blank space focuses the dialog itself, so after either the
  // keydown lands outside any handler the form could put on its own element.
  // Listened on the window but scoped to the dialog the form sits in (or the
  // form, drawn without one): once the dialog closes, focus is back on what
  // opened it, so a keypress during the closing animation creates nothing.
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.defaultPrevented || event.isComposing || event.repeat) return;
      const root = rootRef.current;
      const scope = root?.closest('[role="dialog"]') ?? root;
      if (!scope || !(event.target instanceof Node) || !scope.contains(event.target)) return;
      event.preventDefault();
      void createRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    // While the bot is being created nothing in the form can change under it:
    // a disabled fieldset disables every control inside, the header's close
    // and the footer's buttons included (Escape still closes the dialog).
    <fieldset ref={rootRef} disabled={busy} className="m-0 flex min-w-0 flex-col border-0 p-0">
      <DialogHeader className="h-[52px] border-b-0 bg-transparent py-0 pl-5">
        <DialogTitle className="font-display text-[17px] font-semibold tracking-[-0.01em]">{copy.title}</DialogTitle>
      </DialogHeader>
      {gated ? (
        <div className="px-5 pb-5">
          <div className="border border-border">
            <BotsRelayGate profile={profile} relayVersion={relay.version} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-[18px] px-5 pt-1 pb-5">
          <div className="flex items-center gap-[18px]">
            <MascotPicker value={mascot} onChange={setMascot} open={pickerOpen} onOpenChange={setPickerOpen}>
              <Button variant="outline" aria-label={copy.changeMascot} className="relative size-24 shrink-0 bg-bg-chrome p-0 hover:bg-bg-chrome" style={MASCOT_FRAME_STYLE}>
                <Mascot mascot={mascot} size={64} backdrop="var(--bg-chrome)" />
                <span aria-hidden className="absolute -right-[7px] -bottom-[7px] flex size-6 items-center justify-center border border-border bg-bg-elevated text-muted-foreground">
                  <Pencil className="size-3" />
                </span>
              </Button>
            </MascotPicker>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Input
                value={name}
                maxLength={40}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder={copy.namePlaceholder}
                aria-label={copy.namePlaceholder}
                className="h-[42px] border-0 border-b bg-transparent px-0 font-display text-[26px] font-semibold tracking-[-0.015em] focus-visible:ring-0"
              />
              <TextButton onClick={() => setPickerOpen(true)} className="w-fit font-mono text-[11.5px]">
                {mascotSummary(dict, mascot)} · {dict.bots.mascot.change}
              </TextButton>
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">{copy.soul}</span>
            <Textarea value={soul} rows={4} onChange={(event) => setSoul(event.target.value)} placeholder={copy.soulPlaceholder} className="font-sans text-[13.5px]" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">{copy.agent}</span>
              <Select value={agentId} onValueChange={setAgentId} disabled={agents.length < 2}>
                <SelectTrigger aria-label={copy.agent} className="w-full font-sans text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(agents.length > 0 ? agents : [agentId]).map((id) => (
                    <SelectItem key={id} value={id} className="font-sans text-[13px]">
                      <AgentLogo agentId={id} className="size-3.5 shrink-0" />
                      {agentName(dict.chat.composer.agentNames, id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">{copy.profile}</span>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger aria-label={copy.profile} className="w-full font-sans text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((each) => (
                    <SelectItem key={each.id} value={each.id} className="font-sans text-[13px]">
                      <span aria-hidden className={cn("size-2 shrink-0", profileColorClass(each.id))} />
                      <span className="truncate">{each.label}</span>
                      <span className="font-mono text-[11px] text-text-faint">{each.host}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {template && words && (
            <div className="-mt-1 flex flex-col gap-1.5 font-mono text-[11.5px] leading-normal text-text-faint">
              <span className="flex gap-2">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                {copy.readOnly}
              </span>
              <label className="flex cursor-pointer items-center gap-2">
                <CalendarClock className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{(scheduleOn ? copy.scheduleOn : copy.scheduleOff).replace("{when}", words.when)}</span>
                <Switch checked={scheduleOn} onCheckedChange={setScheduleOn} aria-label={words.scheduleName} />
              </label>
            </div>
          )}
        </div>
      )}
      <div className="flex h-[60px] shrink-0 items-center gap-2 border-t border-border px-3.5">
        <Button variant="chrome" size="sm" onClick={onTemplates} className="font-sans text-[13px]">
          <LayoutGrid className="size-3.5" />
          {copy.fromTemplate}
        </Button>
        <span className="flex-1" />
        {error && <p className="max-w-[220px] text-xs text-destructive">{error}</p>}
        <Button variant="ghost" onClick={closeNewBot}>
          {dict.common.cancel}
        </Button>
        {/* The label stays the same while it loads, so the button keeps its
            width; faded while busy, since nothing in the form can be used then. */}
        <Button ref={createButtonRef} loading={busy} disabled={!ready} onClick={() => void create()} className="data-loading:disabled:opacity-50">
          {copy.create}
          <KbdShortcut keys={shortcutKeys("↵")} size="sm" className="[&_kbd]:border-background/25 [&_kbd]:bg-transparent [&_kbd]:text-background/75" />
        </Button>
      </div>
    </fieldset>
  );
}
