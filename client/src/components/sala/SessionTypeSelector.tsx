import { useId } from "react";
import { useDict } from "@/i18n";
import { Segmented } from "@/components/ui/segmented";
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
  // Every tab keeps its panel mounted, so two new-session screens can be in
  // the DOM at once: the options' ids must not collide.
  const id = useId();
  return (
    <Segmented
      id={id}
      kind="radio"
      label={dict.modeLabel}
      value={value}
      onChange={onChange}
      className="border-border-soft bg-bg-sidebar"
      options={[
        { value: "conversation", label: dict.conversation, icon: <ConversationGlyph size={14} /> },
        { value: "room", label: dict.room, icon: <RoomGlyph size={14} /> },
      ]}
    />
  );
}
