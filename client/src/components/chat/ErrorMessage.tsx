import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";

/** The way back in from a turn that failed for a lost (or never made)
 * login: the button, and the sentence that replaces the CLI's own message —
 * "Please run /login" is an instruction for its terminal, not for this app. */
export interface ReconnectAction {
  label: string;
  explanation: string;
  onClick: () => void;
}

/** A turn that failed. Framed like the tool call above it rather than left
 * as loose red text — in a log made of bordered cards, unframed text read
 * as part of the assistant's own answer. A failure the agent put down to a
 * lost login carries the way back in (`reconnect`), in its own words. */
export const ErrorMessage = memo(function ErrorMessage({ message, reconnect }: { message: string; reconnect?: ReconnectAction }) {
  const dict = useDict();
  return (
    <div className="flex items-center gap-3 border border-destructive/40 bg-card px-2.5 py-2">
      <p className="min-w-0 flex-1 text-xs text-destructive">{reconnect ? reconnect.explanation : dict.chat.log.error.replace("{message}", message)}</p>
      {reconnect && (
        <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={reconnect.onClick}>
          {reconnect.label}
        </Button>
      )}
    </div>
  );
});
