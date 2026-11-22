import { ChevronDown, Plus } from "lucide-react";
import { RowButton } from "@/components/ui/row-button";
import { Button } from "@/components/ui/button";
import { Mascot } from "@/components/bots/Mascot";
import { useDict } from "@/i18n";
import { useBots } from "@/lib/bots/botsStore";
import { mascotStateOf } from "@/lib/bots/mascot";
import { cn } from "@/lib/utils";

/** The iOS drawer's two sections, which take turns (the desktop sidebar
 * has a Bots group that folds on its own instead: `BotsHeading`). */
export type SidebarSection = "bots" | "conversations";

const STORAGE_KEY = "anywh:sidebar-section";

export function loadSidebarSection(): SidebarSection {
  try {
    return localStorage.getItem(STORAGE_KEY) === "bots" ? "bots" : "conversations";
  } catch {
    return "conversations";
  }
}

export function saveSidebarSection(section: SidebarSection): void {
  try {
    localStorage.setItem(STORAGE_KEY, section);
  } catch {
    // Not remembering the section is no reason to fail the click.
  }
}

const BOTS_OPEN_KEY = "anywh:sidebar-bots-open";

/** Whether the desktop sidebar's Bots group is open (it is, unless folded). */
export function loadBotsOpen(): boolean {
  try {
    return localStorage.getItem(BOTS_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveBotsOpen(open: boolean): void {
  try {
    localStorage.setItem(BOTS_OPEN_KEY, String(open));
  } catch {
    // Not remembering the fold is no reason to fail the click.
  }
}

/**
 * The heading of the desktop sidebar's Bots group, above the conversation
 * groups (needs you, running, recent) and folding on its own like them.
 * Folded, it still shows the faces of the bots that need the person, so
 * nothing waiting goes unseen.
 */
export function BotsHeading({ open, profileId, onToggle, onAdd }: { open: boolean; profileId: string; onToggle: () => void; onAdd: () => void }) {
  const dict = useDict();
  const bots = useBots(profileId);
  const waiting = open ? [] : bots.filter((bot) => bot.needsYou > 0);
  return (
    <div className="relative shrink-0 px-2 pt-2">
      <RowButton
        tone="faint"
        aria-expanded={open}
        onClick={onToggle}
        className="h-[24px] gap-2 font-mono text-[length:calc(11.5px*var(--chrome-scale))] font-medium"
      >
        <ChevronDown className={cn("-mr-1 size-2.5 shrink-0", !open && "-rotate-90")} aria-hidden />
        <span className="dark:opacity-80">{dict.bots.section}</span>
        <span aria-hidden="true" className="min-w-0 flex-1 border-t border-dashed border-border" />
        {waiting.length > 0 && (
          <span className="flex items-center gap-1" title={dict.bots.collapsedNeedsYou.replace("{count}", String(waiting.length))}>
            {waiting.slice(0, 4).map((bot) => (
              <Mascot key={bot.id} mascot={bot.mascot} state={mascotStateOf(bot)} size={16} />
            ))}
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          </span>
        )}
        <span className="w-5 shrink-0" aria-hidden />
      </RowButton>
      <Button
        variant="chrome"
        size="inline"
        aria-label={dict.bots.newBot}
        title={dict.bots.newBot}
        onClick={onAdd}
        className="absolute top-2 right-2 h-[24px] w-6 justify-center text-text-faint hover:bg-bg-hover"
      >
        <Plus className="size-3" />
      </Button>
    </div>
  );
}
