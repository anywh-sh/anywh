import type { KeyboardEvent } from "react";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import { ConversationGlyph, RoomGlyph } from "@/components/sala/SalaIcons";

export type SessionType = "conversation" | "room";

interface SessionTypeSelectorProps {
  value: SessionType;
  onChange: (value: SessionType) => void;
}

/**
 * The new-session screen's choice between a conversation and a room. It is
 * made once, here: a session's type is not something that can be switched
 * from its header afterwards.
 */
export function SessionTypeSelector({ value, onChange }: SessionTypeSelectorProps) {
  const dict = useDict().sala.newSession;
  const options: { id: SessionType; label: string; icon: React.ReactNode }[] = [
    { id: "conversation", label: dict.conversation, icon: <ConversationGlyph size={14} /> },
    { id: "room", label: dict.room, icon: <RoomGlyph size={14} /> },
  ];
  // A radio group is one tab stop, moved with the arrow keys.
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = options[(options.findIndex((o) => o.id === value) + step + options.length) % options.length];
    onChange(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-type="${next.id}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={dict.modeLabel} onKeyDown={move} className="flex gap-0.5 border border-border-soft bg-bg-sidebar p-0.5">
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-type={option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "inline-flex h-[26px] cursor-pointer items-center gap-[7px] px-[11px] text-[12.5px] transition-colors outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--text-faint)]",
              on ? "bg-border-soft text-foreground" : "text-text-faint hover:bg-bg-hover hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
