import { ChevronDown, Plus } from "lucide-react";
import { RowButton } from "@/components/ui/row-button";
import { Button } from "@/components/ui/button";
import { Mascot } from "@/components/bots/Mascot";
import { useDict } from "@/i18n";
import { useBots } from "@/lib/bots/botsStore";
import { mascotStateOf } from "@/lib/bots/mascot";
import { cn } from "@/lib/utils";

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

/**
 * The heading of one of the sidebar's two sections. Only one is open at a
 * time: the open one sits at the top with its list, the folded one drops to
 * the bottom as this heading alone. Folded, the Bots heading still shows the
 * faces of the bots that need the person, so nothing waiting goes unseen.
 */
export function SidebarSectionHeading({
  section,
  open,
  profileId,
  onToggle,
  onAdd,
}: {
  section: SidebarSection;
  open: boolean;
  profileId: string;
  onToggle: () => void;
  /** The section's "+" (a new bot). */
  onAdd?: () => void;
}) {
  const dict = useDict();
  const bots = useBots(profileId);
  const waiting = section === "bots" && !open ? bots.filter((bot) => bot.needsYou > 0) : [];
  const label = section === "bots" ? dict.bots.section : dict.bots.conversations;
  return (
    <div className={cn("relative shrink-0 px-2", open ? "pt-2" : "border-t border-border py-1")}>
      <RowButton
        tone="faint"
        aria-expanded={open}
        onClick={onToggle}
        className="h-[24px] gap-2 font-mono text-[length:calc(11.5px*var(--chrome-scale))] font-medium"
      >
        <ChevronDown className={cn("-mr-1 size-2.5 shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="dark:opacity-80">{label}</span>
        <span aria-hidden="true" className="min-w-0 flex-1 border-t border-dashed border-border" />
        {waiting.length > 0 && (
          <span className="flex items-center gap-1" title={dict.bots.collapsedNeedsYou.replace("{count}", String(waiting.length))}>
            {waiting.slice(0, 4).map((bot) => (
              <Mascot key={bot.id} seed={bot.mascot.seed} state={mascotStateOf(bot)} size={12} />
            ))}
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          </span>
        )}
        {onAdd && <span className="w-5 shrink-0" aria-hidden />}
      </RowButton>
      {onAdd && (
        <Button
          variant="chrome"
          size="inline"
          aria-label={dict.bots.newBot}
          title={dict.bots.newBot}
          onClick={onAdd}
          className={cn("absolute right-2 h-[24px] w-6 justify-center text-text-faint hover:bg-bg-hover", open ? "top-2" : "top-1")}
        >
          <Plus className="size-3" />
        </Button>
      )}
    </div>
  );
}
