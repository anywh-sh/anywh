import { useEffect, useState } from "react";
import { ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Mascot } from "@/components/bots/Mascot";
import { BotPanel } from "@/components/bots/BotPanel";
import { useDict } from "@/i18n";
import { useBots } from "@/lib/bots/botsStore";
import { onPanelTask } from "@/lib/bots/botTaskRequest";
import { mascotStateOf } from "@/lib/bots/mascot";
import type { Profile } from "@/lib/profiles/profiles";

/**
 * Where there is no side panel (iOS, a narrow window), a bot's conversation
 * carries a bar with the bot and its tasks: the task list opens as a sheet
 * over the conversation, which stays connected underneath.
 */
export function BotCompactBar({ profile, roomId, onOpenSession }: { profile: Profile; roomId: string; onOpenSession: (sessionId: string, title: string | null) => void }) {
  const dict = useDict();
  const bot = useBots(profile.id).find((each) => each.roomId === roomId);
  const [open, setOpen] = useState(false);
  // A task asked for from the conversation opens the sheet; the panel in it
  // takes the request as it mounts.
  useEffect(() => onPanelTask(roomId, () => setOpen(true)), [roomId]);
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-3 py-2">
        {bot && <Mascot mascot={bot.mascot} state={mascotStateOf(bot)} size={32} badge backdrop="var(--background)" />}
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{bot?.name}</span>
        <Button variant={bot && bot.needsYou > 0 ? "outline" : "ghost"} size="xs" onClick={() => setOpen(true)} className={bot && bot.needsYou > 0 ? "border-primary text-primary" : undefined}>
          <ListTodo />
          {dict.bots.panel.tasks}
          {bot && bot.needsYou > 0 && <span className="size-1.5 rounded-full bg-primary" aria-hidden />}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" showCloseButton={false} className="h-[85dvh] gap-0 p-0">
          <SheetTitle className="sr-only">{dict.bots.panel.tasks}</SheetTitle>
          <BotPanel
            profile={profile}
            roomId={roomId}
            onOpenSession={(sessionId, title) => {
              setOpen(false);
              onOpenSession(sessionId, title);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
