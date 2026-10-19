import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface LogEntryRowProps {
  children: ReactNode;
  className?: string;
}

/**
 * Vertical rhythm between entries in the log, and nothing else: 4px here on
 * each side plus the 4px the virtualized row adds, so 12px between one
 * entry and the next — the design's gap between a thinking line, the
 * activity line and the text.
 *
 * It used to draw a coloured rail down the left of tool calls and errors.
 * The design has no rails: a tool call is already a bordered card, and the
 * rail was a second frame around something that was framed — what it marked
 * was legible without it. An error says it is an error in its own tone.
 *
 * Memoized — see comment on `Message.tsx::UserBubble`. Without this, the
 * wrapper would reconcile (and the memoized child inside it would bail out
 * too late) on every `MessageLog` render, even with `children` unchanged.
 */
export const LogEntryRow = memo(function LogEntryRow({ children, className }: LogEntryRowProps) {
  return <div className={cn("py-1", className)}>{children}</div>;
});
