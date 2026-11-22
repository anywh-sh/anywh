import { memo, useMemo } from "react";
import { mascotChoiceOf, mascotLayers, MASCOT_GRID, type MascotState } from "@/lib/bots/mascot";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface MascotProps {
  /** The character and tone: a bot's `mascot` (`MascotChoice`), read
   * defensively, so anything else draws Bip. */
  mascot: unknown;
  state?: MascotState;
  /** Pixels; a multiple of 16 keeps every cell on whole pixels. */
  size?: number;
  /** Draws the state as a corner mark too (32 px and under, where the face
   * alone is hard to read). */
  badge?: boolean;
  /** The color behind the mascot, which rings the mark so it reads as cut
   * out of the face. */
  backdrop?: string;
  className?: string;
  title?: string;
}

/**
 * A bot's pixel face (see `lib/bots/mascot.ts`): one SVG of square runs, one
 * path per color, never smoothed.
 */
export const Mascot = memo(function Mascot({ mascot, state = "idle", size = 32, badge = false, backdrop = "var(--bg-sidebar)", className, title }: MascotProps) {
  const { character, tone } = mascotChoiceOf(mascot);
  const layers = useMemo(() => mascotLayers({ character, tone }, state), [character, tone, state]);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} data-mascot-state={state} data-mascot={`${character}:${tone}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${String(MASCOT_GRID)} ${String(MASCOT_GRID)}`}
        shapeRendering="crispEdges"
        role={title ? "img" : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        className="block"
      >
        {layers.map((layer) => (
          <path key={layer.layer} fill={layer.color} d={layer.rects.map(([x, y, w, h]) => `M${String(x)} ${String(y)}h${String(w)}v${String(h)}h-${String(w)}z`).join("")} />
        ))}
      </svg>
      {badge && state !== "idle" && state !== "setup" && <MascotBadge state={state} size={size} backdrop={backdrop} />}
    </span>
  );
});

/** The state's mark in the bottom-right corner, ringed in the backdrop. */
function MascotBadge({ state, size, backdrop }: { state: Exclude<MascotState, "idle" | "setup">; size: number; backdrop: string }) {
  const box = size <= 32 ? 10 : size <= 64 ? 12 : 16;
  const offset = size <= 32 ? -3 : -4;
  const ring = size <= 32 ? 2 : 3;
  const position = { right: offset, bottom: offset } as const;
  if (state === "needsYou") {
    return <span aria-hidden data-mascot-badge={state} className="absolute rounded-full bg-primary" style={{ ...position, width: box - 1, height: box - 1, boxShadow: `0 0 0 ${String(ring)}px ${backdrop}` }} />;
  }
  return (
    <span
      aria-hidden
      data-mascot-badge={state}
      className="absolute flex items-center justify-center rounded-full"
      style={{ ...position, width: box, height: box, background: backdrop, boxShadow: `0 0 0 ${String(ring - 1)}px ${backdrop}` }}
    >
      {state === "working" && <Spinner size="xs" className="size-[7px]" />}
      {state === "failed" && <span className="border-[1.5px] border-destructive" style={{ width: box - 3, height: box - 3 }} />}
      {state === "paused" && (
        <svg width={box} height={box} viewBox="0 0 10 10" className="block text-muted-foreground">
          <path d="M3 2v6M7 2v6" stroke="currentColor" strokeWidth={1.8} />
        </svg>
      )}
      {state === "limit" && (
        <svg width={box} height={box} viewBox="0 0 10 10" className="block text-destructive">
          <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth={1.4} />
          <path d="M5 2.8V5l1.6 1" fill="none" stroke="currentColor" strokeWidth={1.3} />
        </svg>
      )}
    </span>
  );
}
