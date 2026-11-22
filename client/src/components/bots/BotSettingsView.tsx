import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Mascot } from "@/components/bots/Mascot";
import { useDict } from "@/i18n";
import { deleteBot, editMemoryLine, fetchBot, patchBot } from "@/lib/bots/botClient";
import type { BotView, MemoryLine } from "@/lib/bots/botTypes";
import { mascotStateOf } from "@/lib/bots/mascot";
import type { Profile } from "@/lib/profiles/profiles";

type Section = "soul" | "memory" | "bot";

interface BotSettingsDialogProps {
  profile: Profile;
  botId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bot was deleted: the caller closes its tab. */
  onDeleted: (roomId: string) => void;
}

/**
 * A bot's settings: who it is (its soul), what it remembers (one line each,
 * editable), and the bot itself (name, pause, delete). Its permission mode,
 * agent and model are its conversation's, set in its composer like any
 * conversation's.
 */
export function BotSettingsDialog({ profile, botId, open, onOpenChange, onDeleted }: BotSettingsDialogProps) {
  const dict = useDict();
  const [section, setSection] = useState<Section>("soul");
  const [loaded, setLoaded] = useState<{ bot: BotView; soul: string; memory: MemoryLine[] } | null>(null);
  const [soul, setSoul] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    if (!open) return;
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
  }, [open, profile, botId]);

  const save = (work: Promise<unknown>): void => {
    setStatus("saving");
    work.then(
      () => setStatus("saved"),
      () => setStatus("failed"),
    );
  };

  const bot = loaded?.bot;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="bot-settings-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {bot && <Mascot seed={bot.mascot.seed} state={mascotStateOf(bot)} size={24} />}
            {dict.bots.settings.title.replace("{name}", bot?.name ?? "")}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="gap-4">
          <Segmented
            id="bot-settings-section"
            label={dict.bots.menu.settings}
            value={section}
            onChange={setSection}
            options={[
              { value: "soul", label: dict.bots.settings.soul },
              { value: "memory", label: dict.bots.settings.memory },
              { value: "bot", label: dict.bots.settings.bot },
            ]}
          />
          {!loaded ? (
            status === "failed" ? <p className="text-sm text-destructive">{dict.bots.settings.saveFailed}</p> : <Spinner size="md" />
          ) : section === "soul" ? (
            <div className="flex flex-col gap-2" role="tabpanel" aria-labelledby="bot-settings-section-soul">
              <Textarea value={soul} rows={14} onChange={(event) => setSoul(event.target.value)} className="font-mono text-xs" />
              <div className="flex items-center gap-3">
                <Button size="xs" disabled={soul.trim() === "" || soul === loaded.soul} onClick={() => save(patchBot(profile, botId, { soul }).then(() => setLoaded({ ...loaded, soul })))}>
                  {dict.bots.settings.save}
                </Button>
                <SaveStatus status={status} />
              </div>
            </div>
          ) : section === "memory" ? (
            <MemoryList profile={profile} botId={botId} lines={loaded.memory} onChange={(memory) => setLoaded({ ...loaded, memory })} />
          ) : (
            <div className="flex flex-col gap-4" role="tabpanel" aria-labelledby="bot-settings-section-bot">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-text-faint">{dict.bots.settings.rename}</span>
                <div className="flex gap-2">
                  <Input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} className="flex-1" />
                  <Button size="xs" className="h-9" disabled={name.trim() === "" || name.trim() === loaded.bot.name} onClick={() => save(patchBot(profile, botId, { name: name.trim() }))}>
                    {dict.bots.settings.save}
                  </Button>
                </div>
              </label>
              <label className="flex items-start gap-3">
                <Switch checked={loaded.bot.paused} onCheckedChange={(paused) => save(patchBot(profile, botId, { paused }).then(() => setLoaded({ ...loaded, bot: { ...loaded.bot, paused } })))} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">{loaded.bot.paused ? dict.bots.settings.resume : dict.bots.settings.pause}</span>
                  <span className="text-xs text-text-faint">{dict.bots.settings.pauseHint}</span>
                </span>
              </label>
              <SaveStatus status={status} />
              <Button
                variant="destructive-outline"
                size="xs"
                className="self-start"
                onClick={() => {
                  void confirmDialog(dict.bots.settings.deleteConfirm.replace("{name}", loaded.bot.name), {
                    title: dict.bots.settings.delete,
                    kind: "warning",
                    okLabel: dict.common.delete,
                    cancelLabel: dict.common.cancel,
                  }).then((confirmed) => {
                    if (!confirmed) return;
                    deleteBot(profile, botId).then(
                      () => {
                        onOpenChange(false);
                        onDeleted(loaded.bot.roomId);
                      },
                      () => setStatus("failed"),
                    );
                  });
                }}
              >
                <Trash2 />
                {dict.bots.settings.delete}
              </Button>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
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
