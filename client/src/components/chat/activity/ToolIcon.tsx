import { Bot, FileText, Globe, Pencil, Plug, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { ToolCallEntry } from "@/hooks/relay/useMessageLog";

const ICONS: Record<string, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  write: Pencil,
  shell: Terminal,
  search: Search,
  web: Globe,
  mcp: Plug,
  task: Bot,
};

/** The glyph for a call, from what it does (`subject`) before what it is
 * called (`toolKind`) — a Codex `sed -n` that is really a read gets the read
 * icon. Unknown kinds get the wrench. Decorative: the row's text names it. */
export function ToolIcon({ call, className }: { call: ToolCallEntry; className?: string }) {
  const Icon = ICONS[call.subject?.kind ?? call.toolKind] ?? Wrench;
  return <Icon className={className} aria-hidden />;
}
