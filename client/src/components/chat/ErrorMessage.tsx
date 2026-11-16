import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";

/** A turn that failed. Framed like the tool call above it rather than left
 * as loose red text — in a log made of bordered cards, unframed text read
 * as part of the assistant's own answer. A failure the agent put down to a
 * lost login carries the way back in (`reconnect`). */
export const ErrorMessage = memo(function ErrorMessage({ message, reconnect }: { message: string; reconnect?: { label: string; onClick: () => void } }) {
  const dict = useDict();
  return (
    <div className="flex items-center gap-3 border border-destructive/40 bg-card px-2.5 py-2">
      <p className="min-w-0 flex-1 text-xs text-destructive">{dict.chat.log.error.replace("{message}", message)}</p>
      {reconnect && (
        <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={reconnect.onClick}>
          {reconnect.label}
        </Button>
      )}
    </div>
  );
});
