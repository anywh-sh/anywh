import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { TextButton } from "@/components/ui/text-button";
import { Mascot } from "@/components/bots/Mascot";
import { MASCOT_FRAME_STYLE, MascotPicker, mascotSummary } from "@/components/bots/MascotPicker";
import { useDict } from "@/i18n";
import { deleteBot, editMemoryLine, fetchBot, patchBot } from "@/lib/bots/botClient";
import type { BotView, MemoryLine } from "@/lib/bots/botTypes";
import { mascotChoiceOf } from "@/lib/bots/mascot";
import type { Profile } from "@/lib/profiles/profiles";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

interface BotSettingsProps {
  profile: Profile;
  /** The bot as its room's channel sends it: name, face and pause stay live. */
  bot: BotView;
  /** "‹ Tasks": back to the task list. */
  onBack: () => void;
  /** What the relay would answer, instead of asking it (the stories). */
  initial?: { soul: string; memory: MemoryLine[] };
}

/**
 * A bot's settings, in its side panel (the header's gear opens them): its
 * name and face, who it is (its soul), what it remembers, and pausing or
 * deleting it. One column of sections. Its agent, model and permission mode
 * are its conversation's, set in its composer like any conversation's.
 */
export function BotSettings({ profile, bot, onBack, initial }: BotSettingsProps) {
  const dict = useDict();
  const copy = dict.bots.settings;
  const [loaded, setLoaded] = useState<{ soul: string; memory: MemoryLine[] } | null>(initial ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [soul, setSoul] = useState(initial?.soul ?? "");
  const [name, setName] = useState(bot.name);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [pickerOpen, setPickerOpen] = useState(false);
  const mascot = mascotChoiceOf(bot.mascot);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetchBot(profile, bot.id).then(
      (result) => {
        if (cancelled) return;
        setLoaded({ soul: result.soul, memory: result.memory });
        setSoul(result.soul);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // `initial` only stands in for the first answer (the stories).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, bot.id]);

  const save = (work: Promise<unknown>): void => {
    setStatus("saving");
    work.then(
      () => setStatus("saved"),
      () => setStatus("failed"),
    );
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col px-3 pt-2 pb-4" data-testid="bot-settings">
        <div className="flex items-center gap-1 pb-2">
          <Button variant="ghost" size="xs" onClick={onBack}>
            <ChevronLeft />
            {dict.bots.task.back}
          </Button>
          <span className="flex-1" />
          <SaveState status={status} />
        </div>

        <Section title={copy.nameAndMascot}>
          <div className="flex items-center gap-3">
            <MascotPicker value={mascot} onChange={(next) => save(patchBot(profile, bot.id, { mascot: next }))} open={pickerOpen} onOpenChange={setPickerOpen}>
              <Button variant="outline" aria-label={dict.bots.create.changeMascot} className="size-14 shrink-0 bg-bg-chrome p-0 hover:bg-bg-chrome" style={MASCOT_FRAME_STYLE}>
                <Mascot mascot={mascot} size={48} backdrop="var(--bg-chrome)" />
              </Button>
            </MascotPicker>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex gap-1.5">
                <Input value={name} maxLength={40} aria-label={copy.rename} onChange={(event) => setName(event.target.value)} className="h-8 min-w-0 flex-1 font-sans text-[13.5px]" />
                <Button variant="outline" size="sm" className="h-8" disabled={name.trim() === "" || name.trim() === bot.name} onClick={() => save(patchBot(profile, bot.id, { name: name.trim() }))}>
                  {copy.save}
                </Button>
              </div>
              <TextButton onClick={() => setPickerOpen(true)} className="w-fit font-mono text-[11px]">
                {mascotSummary(dict, mascot)} · {dict.bots.mascot.change}
              </TextButton>
            </div>
          </div>
        </Section>

        <Section title={copy.soul}>
          {loaded ? (
            <>
              <Textarea value={soul} rows={10} aria-label={copy.soul} onChange={(event) => setSoul(event.target.value)} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={soul.trim() === "" || soul === loaded.soul}
                onClick={() => save(patchBot(profile, bot.id, { soul }).then(() => setLoaded({ ...loaded, soul })))}
              >
                {copy.save}
              </Button>
            </>
          ) : (
            <Loading failed={loadFailed} />
          )}
        </Section>

        <Section title={copy.memory} count={loaded?.memory.length}>
          {loaded ? <MemoryList profile={profile} botId={bot.id} lines={loaded.memory} onChange={(memory) => setLoaded({ ...loaded, memory })} /> : <Loading failed={loadFailed} />}
        </Section>

        <Section title={copy.pauseOrDelete} last>
          <label className="flex cursor-pointer items-start gap-3">
            <Switch checked={bot.paused} onCheckedChange={(paused) => save(patchBot(profile, bot.id, { paused }))} aria-label={bot.paused ? copy.resume : copy.pause} />
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] text-foreground">{bot.paused ? copy.resume : copy.pause}</span>
              <span className="text-xs leading-snug text-text-faint">{copy.pauseHint}</span>
            </span>
          </label>
          <Button
            variant="destructive-outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              void confirmDialog(copy.deleteConfirm.replace("{name}", bot.name), {
                title: copy.delete,
                kind: "warning",
                okLabel: dict.common.delete,
                cancelLabel: dict.common.cancel,
              }).then((confirmed) => {
                // The bot leaving the list closes its tabs, this panel with them.
                if (confirmed) deleteBot(profile, bot.id).catch(() => setStatus("failed"));
              });
            }}
          >
            <Trash2 />
            {copy.delete}
          </Button>
        </Section>
      </div>
    </ScrollArea>
  );
}

function Section({ title, count, last = false, children }: { title: string; count?: number; last?: boolean; children: ReactNode }) {
  return (
    <section className={last ? "flex flex-col gap-2.5 pt-4" : "flex flex-col gap-2.5 border-b border-border py-4"}>
      <h3 className="flex items-baseline gap-2 font-display text-[14px] font-semibold text-foreground">
        {title}
        {count !== undefined && count > 0 && <span className="font-mono text-[11px] font-normal text-text-faint">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Loading({ failed }: { failed: boolean }) {
  const dict = useDict();
  return failed ? <p className="text-xs text-destructive">{dict.bots.settings.saveFailed}</p> : <Spinner size="sm" />;
}

function SaveState({ status }: { status: SaveStatus }) {
  const dict = useDict();
  if (status === "saved") return <span className="font-mono text-[11px] text-text-faint">{dict.bots.settings.saved}</span>;
  if (status === "failed") return <span className="text-xs text-destructive">{dict.bots.settings.saveFailed}</span>;
  if (status === "saving") return <Spinner size="sm" />;
  return null;
}

function MemoryList({ profile, botId, lines, onChange }: { profile: Profile; botId: string; lines: MemoryLine[]; onChange: (lines: MemoryLine[]) => void }) {
  const dict = useDict();
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const run = (index: number, text: string | null): void => {
    setFailed(false);
    editMemoryLine(profile, botId, index, text).then(
      (memory) => {
        setEditing(null);
        onChange(memory);
      },
      () => setFailed(true),
    );
  };
  if (lines.length === 0) return <p className="text-xs text-text-faint">{dict.bots.settings.memoryEmpty}</p>;
  return (
    <div className="flex flex-col">
      {lines.map((line) => (
        <div key={`${String(line.index)}:${line.raw}`} className="group flex items-start gap-2 border-b border-border py-2 last:border-b-0">
          {editing?.index === line.index ? (
            <div className="flex min-w-0 flex-1 gap-1.5">
              <Input value={editing.text} autoFocus onChange={(event) => setEditing({ index: line.index, text: event.target.value })} className="h-8 min-w-0 flex-1 font-sans text-[13px]" />
              <Button size="xs" className="h-8" disabled={editing.text.trim() === ""} onClick={() => run(line.index, editing.text)}>
                {dict.bots.settings.save}
              </Button>
              <Button variant="outline" size="xs" className="h-8" onClick={() => setEditing(null)}>
                {dict.bots.settings.cancel}
              </Button>
            </div>
          ) : (
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] leading-snug text-foreground">{line.text}</span>
                <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-text-faint">
                  {line.kind && <Badge variant="outline" className="px-1 py-0 font-mono text-[10px] normal-case">{dict.bots.settings.kinds[line.kind]}</Badge>}
                  {[line.source, line.date].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Button variant="quiet" size="icon-xs" aria-label={dict.bots.settings.edit} onClick={() => setEditing({ index: line.index, text: line.text })}>
                <Pencil />
              </Button>
              <Button variant="quiet" size="icon-xs" aria-label={dict.bots.settings.remove} onClick={() => run(line.index, null)}>
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      ))}
      {failed && <p className="pt-2 text-xs text-destructive">{dict.bots.settings.saveFailed}</p>}
    </div>
  );
}
