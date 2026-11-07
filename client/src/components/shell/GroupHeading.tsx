import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A foldable group's heading, as the sidebar draws its session groups:
 * chevron, label, a dashed rule and the group's count. Pressing it folds or
 * unfolds the group; the heading stays either way, with its count.
 */
export function GroupHeading({ label, count, collapsed, onToggle }: { label: string; count: number; collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex h-[21px] w-full cursor-pointer items-center gap-2 px-2 pb-1.5 text-left font-mono text-[length:calc(11.5px*var(--chrome-scale))] font-medium text-text-faint transition-colors hover:text-muted-foreground"
    >
      <ChevronDown className={cn("-mr-1 size-2.5 shrink-0 transition-transform", collapsed && "-rotate-90")} aria-hidden />
      <span className="dark:opacity-80">{label}</span>
      <span aria-hidden="true" className="min-w-0 flex-1 border-t border-dashed border-border" />
      <span className="min-w-[2ch] text-right">{count}</span>
    </button>
  );
}

/** The folded groups after pressing `id`'s heading: added, or removed if it
 * was folded already. */
export function toggledIn<T>(current: ReadonlySet<T>, id: T): ReadonlySet<T> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}
