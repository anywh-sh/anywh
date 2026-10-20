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
  return (
    <div role="radiogroup" aria-label={dict.modeLabel} className="flex gap-0.5 border border-border-soft bg-bg-sidebar p-0.5">
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
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
