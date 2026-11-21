import { memo, useMemo } from "react";
import { MASCOT_FACE, MASCOT_GRID, mascotCells, mascotParts, mascotTone, type MascotState } from "@/lib/bots/mascot";
import { cn } from "@/lib/utils";

interface MascotProps {
  seed: string;
  state?: MascotState;
  /** Pixels; a multiple of 12 keeps every cell on whole pixels. */
  size?: number;
  /** Draws the state as a corner mark too (small sizes, where the face alone
   * is hard to read): the sidebar's own signs. */
  badge?: boolean;
  className?: string;
  title?: string;
}

/**
 * A bot's pixel face (see `lib/bots/mascot.ts`): one SVG of square cells,
 * generated from its seed. Square by design — the app has no round corners.
 */
export const Mascot = memo(function Mascot({ seed, state = "idle", size = 24, badge = false, className, title }: MascotProps) {
  const parts = useMemo(() => mascotParts(seed), [seed]);
  const cells = useMemo(() => mascotCells(parts, state), [parts, state]);
  const tone = mascotTone(parts, state);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} data-mascot-state={state}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${String(MASCOT_GRID)} ${String(MASCOT_GRID)}`}
        shapeRendering="crispEdges"
        role={title ? "img" : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
      >
        {cells.map((cell) => (
          <rect key={`${String(cell.x)},${String(cell.y)}`} x={cell.x} y={cell.y} width={1} height={1} fill={cell.face ? MASCOT_FACE : tone} />
        ))}
      </svg>
      {badge && state !== "idle" && state !== "setup" && <MascotBadge state={state} />}
    </span>
  );
});

function MascotBadge({ state }: { state: Exclude<MascotState, "idle" | "setup"> }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2 border border-[var(--bg-sidebar)]",
        state === "needsYou" && "rounded-full bg-primary",
        state === "failed" && "bg-destructive",
        state === "working" && "rounded-full bg-text-faint",
        state === "paused" && "bg-muted-foreground",
      )}
    />
  );
}
