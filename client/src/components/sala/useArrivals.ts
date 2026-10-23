import { useEffect, useReducer, useRef } from "react";

/** A delegated agent's link draws for this long before its window opens. */
export const LINK_DRAW_MS = 420;
/** How long a card's window takes to open (and its log to fade in). */
export const WINDOW_OPEN_MS = 700;
/** How long a new area takes to fade in. */
export const AREA_BORN_MS = 400;

export type ArrivalPhase = "edge" | "frame";

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * How long ago each id arrived, for as long as `span(id)` says it is still
 * arriving. An id arrives when it shows up after the first render where
 * `ready` is true: what was there when the canvas opened is not new, what
 * joins it while it is open is (a card that comes back on Undo too).
 *
 * Worked out during the render itself, not in an effect: the element of an
 * arriving id must carry its arrival classes from its very first render. Set
 * by an effect after mount, a card was painted in place for a frame, hidden by
 * its first phase, and only then opened — a flicker that showed whenever the
 * arrival came from the relay rather than a click (an effect after a click is
 * flushed before the paint, one after a socket message is not). A timer only
 * renders again when a phase ends; the phase is read from the clock.
 */
function useArrivalClock(ids: readonly string[], ready: boolean, span: (id: string) => number): ReadonlyMap<string, number> {
  const seen = useRef<Set<string> | null>(null);
  const since = useRef(new Map<string, number>());
  const now = performance.now();
  if (ready) {
    const present = new Set(ids);
    if (seen.current && !prefersReducedMotion()) for (const id of ids) if (!seen.current.has(id)) since.current.set(id, now);
    for (const id of since.current.keys()) if (!present.has(id)) since.current.delete(id);
    seen.current = present;
  }
  const out = new Map<string, number>();
  for (const [id, at] of since.current) {
    if (now - at >= span(id)) since.current.delete(id);
    else out.set(id, now - at);
  }
  return out;
}

/** Renders again when the next of these moments (ms from now) comes. */
function useWakeAt(delays: readonly number[]): void {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const next = delays.length > 0 ? Math.min(...delays) : Infinity;
  useEffect(() => {
    if (next === Infinity) return;
    // Woken a hair early, the render reads the clock, finds the phase still
    // on and asks for another wake: nothing depends on the timer's precision.
    const timer = window.setTimeout(rerender, Math.max(0, next));
    return () => window.clearTimeout(timer);
  });
}

/**
 * The agents arriving in the room right now, and where each is in the
 * design's choreography: an agent delegated by one already on the canvas is
 * unseen while its link draws down from the parent (`edge`), then its window
 * opens (`frame`); one with no parent there opens at once. Nothing arrives
 * under `prefers-reduced-motion`. `agents` are the ones drawn on the canvas.
 */
export function useArrivals(agents: readonly { agentId: string; parentId?: string }[], ready: boolean): ReadonlyMap<string, ArrivalPhase> {
  const ids = new Set(agents.map((a) => a.agentId));
  const draw = (id: string): number => {
    const parent = agents.find((a) => a.agentId === id)?.parentId;
    return parent !== undefined && ids.has(parent) ? LINK_DRAW_MS : 0;
  };
  // The link's draw time is fixed when the agent arrives, not re-read later.
  const linked = useRef(new Map<string, number>());
  const clock = useArrivalClock(
    agents.map((a) => a.agentId),
    ready,
    (id) => {
      if (!linked.current.has(id)) linked.current.set(id, draw(id));
      return (linked.current.get(id) ?? 0) + WINDOW_OPEN_MS;
    },
  );
  for (const id of linked.current.keys()) if (!clock.has(id)) linked.current.delete(id);
  const phases = new Map<string, ArrivalPhase>();
  const wake: number[] = [];
  for (const [id, t] of clock) {
    const d = linked.current.get(id) ?? 0;
    phases.set(id, t < d ? "edge" : "frame");
    wake.push(t < d ? d - t : d + WINDOW_OPEN_MS - t);
  }
  useWakeAt(wake);
  return phases;
}

/** The areas created in the last moment, which fade in. */
export function useNewAreas(ids: readonly string[], ready: boolean): ReadonlySet<string> {
  const clock = useArrivalClock(ids, ready, () => AREA_BORN_MS);
  useWakeAt([...clock.values()].map((t) => AREA_BORN_MS - t));
  return new Set(clock.keys());
}
