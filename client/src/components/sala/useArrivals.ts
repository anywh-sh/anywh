import { useEffect, useRef, useState } from "react";

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
 * Calls `onNew` for every id that shows up after the first time `ready` is
 * true: what was there when the canvas opened is not new, what arrives while
 * it is open is.
 */
function useNewIds(ids: readonly string[], ready: boolean, onNew: (id: string) => void): void {
  const seen = useRef<Set<string> | null>(null);
  const key = ids.join("\n");
  useEffect(() => {
    if (!ready) return;
    const before = seen.current;
    seen.current = new Set(ids);
    if (!before) return;
    for (const id of ids) if (!before.has(id)) onNew(id);
    // `key` stands for `ids`; `onNew` reads only refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);
}

/** Timers that are cleared when the canvas goes away. */
function useTimers(): (fn: () => void, ms: number) => void {
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all) window.clearTimeout(t);
      all.clear();
    };
  }, []);
  return (fn, ms) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };
}

/**
 * The agents arriving in the room right now, and where each is in the
 * design's choreography: an agent delegated by one already on the canvas is
 * unseen while its link draws down from the parent (`edge`), then its window
 * opens (`frame`); one with no parent there opens at once. Nothing arrives
 * under `prefers-reduced-motion`.
 */
export function useArrivals(agents: readonly { agentId: string; parentId?: string }[], ready: boolean): ReadonlyMap<string, ArrivalPhase> {
  const [phases, setPhases] = useState<ReadonlyMap<string, ArrivalPhase>>(new Map());
  const later = useTimers();
  const byId = useRef(new Map<string, string | undefined>());
  byId.current = new Map(agents.map((a) => [a.agentId, a.parentId]));
  const set = (id: string, phase: ArrivalPhase | null): void =>
    setPhases((prev) => {
      const next = new Map(prev);
      if (phase) next.set(id, phase);
      else next.delete(id);
      return next;
    });
  useNewIds(
    agents.map((a) => a.agentId),
    ready,
    (id) => {
      if (prefersReducedMotion()) return;
      const parent = byId.current.get(id);
      const linked = parent !== undefined && byId.current.has(parent);
      const draw = linked ? LINK_DRAW_MS : 0;
      set(id, linked ? "edge" : "frame");
      if (linked) later(() => set(id, "frame"), draw);
      later(() => set(id, null), draw + WINDOW_OPEN_MS);
    },
  );
  return phases;
}

/** The areas created in the last moment, which fade in. */
export function useNewAreas(ids: readonly string[], ready: boolean): ReadonlySet<string> {
  const [born, setBorn] = useState<ReadonlySet<string>>(new Set());
  const later = useTimers();
  useNewIds(ids, ready, (id) => {
    if (prefersReducedMotion()) return;
    setBorn((prev) => new Set(prev).add(id));
    later(
      () =>
        setBorn((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      AREA_BORN_MS,
    );
  });
  return born;
}
