import { useEffect, useState } from "react";
import { cn, formatDurationLong } from "@/lib/utils";
import { isIOS } from "@/lib/platform/platform";
import { pickThinkingWord } from "@/lib/format/thinkingWords";
import { useDict } from "@/i18n";

interface TurnIndicatorProps {
  /** Epoch ms of when the turn actually started — comes from the relay
   * (`turn_state`), not from when this component mounted. Matters
   * for the device that did NOT send the message (or that connects in the
   * middle of a turn already in progress): without this, the timer would
   * count from when it found out, not the real start, underestimating the
   * time already elapsed. For whoever sent it, `ChatPanel` already fills
   * this in optimistically (`Date.now()` on the send click), so in practice
   * it's always "now" for that tab — the difference only shows up for
   * whoever didn't start it.
   *
   * `null` when idle renders an `invisible` placeholder of the same height.
   * Nothing mounts it idle today — both callers render it only mid-turn — but
   * it was how desktop held this row's space open back when the indicator
   * sat above the composer, outside the scrolling log. */
  startedAt: number | null;
  /** Tools the agent has reached for since the user's last message — the
   * bar's way of saying what the wait is made of. */
  toolCount: number;
}

/** Indicator for a turn in progress — from the moment of sending until the
 * response finishes (covers network latency + the model's reasoning time,
 * which often doesn't expose real thinking text). On desktop it is the last
 * item of the scrolling log, right after the latest message (`ChatPanel`'s
 * `logTrailing`); on iOS it floats above the composer.
 */
export function TurnIndicator({ startedAt, toolCount }: TurnIndicatorProps) {
  const dict = useDict();
  const active = startedAt !== null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [word, setWord] = useState(() => pickThinkingWord(dict.chat.turn.workingWords));

  useEffect(() => {
    if (startedAt === null) return;
    // Redrawn per turn, not per tick — `startedAt` changing IS a new turn.
    setWord(pickThinkingWord(dict.chat.turn.workingWords));
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // `dict` is deliberately not a dependency: switching language mid-turn
    // shouldn't reroll the verb, and the list it reads is only ever used at
    // the instant a turn starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  const tools =
    toolCount === 0
      ? null
      : toolCount === 1
        ? dict.chat.turn.oneToolUsed
        : dict.chat.turn.toolsUsed.replace("{count}", String(toolCount));

  return (
    <div
      className={cn(
        // Fixed height rather than height-from-content: everything inside is
        // conditional on `active`, and the whole point of staying mounted
        // while idle is to hold this row's space open.
        "relative mt-1 flex h-8 items-center gap-2.5 overflow-hidden border border-border bg-card px-2.5",
        isIOS() && "mx-3",
        !active && "invisible",
      )}
      role="status"
    >
      {active && (
        <>
          {/* Only rendered while a turn runs. `invisible` on the parent would
              hide this but keep its animation ticking — a hidden element is
              still animating. */}
          <span className="animate-turn-sweep pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-primary-soft to-transparent" />
          <span className="relative size-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span className="relative flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {word}…
            {tools && ` · ${tools}`}
          </span>
          <span className="relative shrink-0 font-mono text-[11px] text-text-faint">{formatDurationLong(elapsedSeconds)}</span>
        </>
      )}
    </div>
  );
}
