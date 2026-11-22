import { useEffect, useState } from "react";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { RowButton } from "@/components/ui/row-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Mascot } from "@/components/bots/Mascot";
import { useDict } from "@/i18n";
import { deleteBot, editMemoryLine, fetchBot, patchBot } from "@/lib/bots/botClient";
import type { BotView, MemoryLine } from "@/lib/bots/botTypes";
import { mascotStateOf } from "@/lib/bots/mascot";
import type { Profile } from "@/lib/profiles/profiles";

type Section = "soul" | "memory" | "bot";

interface BotSettingsViewProps {
  profile: Profile;
  botId: string;
  /** The bot was deleted: its tabs close. */
  onDeleted: (roomId: string) => void;
  /** The bot was renamed: its tabs follow. */
  onRenamed: (roomId: string, name: string) => void;
  /** What the relay would answer, instead of asking it (the stories). */
  initial?: { bot: BotView; soul: string; memory: MemoryLine[] };
}

/**
 * A bot's settings, as a tab of its own: who it is (its name and soul), what
 * it remembers (one line each, editable), and pausing or deleting it. A
 * header with its face and the pause button, a list of sections on the left,
 * the section on the right. Its permission mode, agent and model are its
 * conversation's, set in its composer like any conversation's.
 */
export function BotSettingsView({ profile, botId, onDeleted, onRenamed, initial }: BotSettingsViewProps) {
  const dict = useDict();
  const copy = dict.bots.settings;
  const [section, setSection] = useState<Section>("soul");
  const [loaded, setLoaded] = useState<{ bot: BotView; soul: string; memory: MemoryLine[] } | null>(initial ?? null);
  const [soul, setSoul] = useState(initial?.soul ?? "");
  const [name, setName] = useState(initial?.bot.name ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    setLoaded(null);
    setStatus("idle");
    fetchBot(profile, botId).then(
      (result) => {
        if (cancelled) return;
        setLoaded(result);
        setSoul(result.soul);
        setName(result.bot.name);
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
    // `initial` only stands in for the first answer (the stories).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, botId]);

  const save = (work: Promise<unknown>): void => {
    setStatus("saving");
    work.then(
      () => setStatus("saved"),
      () => setStatus("failed"),
    );
  };

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="bot-settings-view">
        {status === "failed" ? <p className="text-sm text-destructive">{copy.saveFailed}</p> : <Spinner size="md" />}
      </div>
    );
  }

  const bot = loaded.bot;
  const setPaused = (paused: boolean): void => save(patchBot(profile, botId, { paused }).then(() => setLoaded({ ...loaded, bot: { ...bot, paused } })));
  const sections: { id: Section; label: string; count?: number }[] = [
    { id: "soul", label: copy.soul },
    { id: "memory", label: copy.memory, count: loaded.memory.length },
    { id: "bot", label: copy.pauseOrDelete },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-settings-view">
      <header className="flex shrink-0 items-center gap-4 border-b border-border px-8 py-6">
        <Mascot seed={bot.mascot.seed} state={mascotStateOf(bot)} size={48} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="truncate text-xl font-semibold text-foreground">{bot.name}</h1>
          <span className="truncate font-mono text-[11px] text-text-faint">{copy.subtitle.replace("{date}", new Date(bot.createdAt).toLocaleDateString())}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => setPaused(!bot.paused)}>
          {bot.paused ? <Play /> : <Pause />}
          {bot.paused ? copy.resume : copy.pause}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border p-2" aria-label={dict.bots.menu.settings}>
          {sections.map((each) => (
            <RowButton key={each.id} selected={section === each.id} onClick={() => setSection(each.id)} aria-current={section === each.id ? "page" : undefined}>
              <span className="flex-1">{each.label}</span>
              {each.count !== undefined && each.count > 0 && <span className="font-mono text-[11px] text-text-faint">{each.count}</span>}
            </RowButton>
          ))}
        </nav>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="flex max-w-[720px] flex-col gap-5 px-8 py-6">
            <h2 className="text-lg font-semibold text-foreground">{sections.find((each) => each.id === section)?.label}</h2>
            {section === "soul" ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-text-faint">{copy.rename}</span>
                  <div className="flex gap-2">
                    <Input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} className="flex-1" />
                    <Button
                      variant="outline"
                      className="h-9"
                      disabled={name.trim() === "" || name.trim() === bot.name}
                      onClick={() =>
                        save(
                          patchBot(profile, botId, { name: name.trim() }).then(() => {
                            setLoaded({ ...loaded, bot: { ...bot, name: name.trim() } });
                            onRenamed(bot.roomId, name.trim());
                          }),
                        )
                      }
                    >
                      {copy.save}
                    </Button>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-text-faint">{dict.bots.create.soul}</span>
                  <Textarea value={soul} rows={16} onChange={(event) => setSoul(event.target.value)} className="font-mono text-xs" />
                </label>
                <div className="flex items-center gap-3">
                  <Button disabled={soul.trim() === "" || soul === loaded.soul} onClick={() => save(patchBot(profile, botId, { soul }).then(() => setLoaded({ ...loaded, soul })))}>
                    {copy.save}
                  </Button>
                  <SaveStatus status={status} />
                </div>
              </>
            ) : section === "memory" ? (
              <MemoryList profile={profile} botId={botId} lines={loaded.memory} onChange={(memory) => setLoaded({ ...loaded, memory })} />
            ) : (
              <>
                <label className="flex items-start gap-3 border border-border p-4">
                  <Switch checked={bot.paused} onCheckedChange={setPaused} />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm text-foreground">{bot.paused ? copy.resume : copy.pause}</span>
                    <span className="text-xs text-text-faint">{copy.pauseHint}</span>
                  </span>
                </label>
                <SaveStatus status={status} />
                <div className="flex flex-col items-start gap-2 border border-border p-4">
                  <span className="text-xs text-text-faint">{copy.deleteConfirm.replace("{name}", bot.name)}</span>
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={() => {
                      void confirmDialog(copy.deleteConfirm.replace("{name}", bot.name), {
                        title: copy.delete,
                        kind: "warning",
                        okLabel: dict.common.delete,
                        cancelLabel: dict.common.cancel,
                      }).then((confirmed) => {
                        if (!confirmed) return;
                        deleteBot(profile, botId).then(
                          () => onDeleted(bot.roomId),
                          () => setStatus("failed"),
                        );
                      });
                    }}
                  >
                    <Trash2 />
                    {copy.delete}
                  </Button>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function SaveStatus({ status }: { status: "idle" | "saving" | "saved" | "failed" }) {
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
  if (lines.length === 0) return <p className="text-sm text-text-faint" role="tabpanel">{dict.bots.settings.memoryEmpty}</p>;
  return (
    <div className="flex flex-col border border-border" role="tabpanel" aria-labelledby="bot-settings-section-memory">
      {lines.map((line) => (
        <div key={`${String(line.index)}:${line.raw}`} className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0">
          {line.kind && <Badge variant="outline" className="mt-0.5 w-[88px] justify-center font-mono text-[10.5px]">{dict.bots.settings.kinds[line.kind]}</Badge>}
          {editing?.index === line.index ? (
            <div className="flex min-w-0 flex-1 gap-2">
              <Input value={editing.text} autoFocus onChange={(event) => setEditing({ index: line.index, text: event.target.value })} className="flex-1" />
              <Button size="xs" className="h-9" disabled={editing.text.trim() === ""} onClick={() => run(line.index, editing.text)}>
                {dict.bots.settings.save}
              </Button>
              <Button variant="outline" size="xs" className="h-9" onClick={() => setEditing(null)}>
                {dict.bots.settings.cancel}
              </Button>
            </div>
          ) : (
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm text-foreground">{line.text}</span>
                {(line.date ?? line.source) && <span className="font-mono text-[10.5px] text-text-faint">{[line.source, line.date].filter(Boolean).join(" · ")}</span>}
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
      {failed && <p className="px-3 py-2 text-xs text-destructive">{dict.bots.settings.saveFailed}</p>}
    </div>
  );
}
