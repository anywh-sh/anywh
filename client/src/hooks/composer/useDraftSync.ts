import { useCallback, useEffect, useRef } from "react";

const DRAFT_DEBOUNCE_MS = 400;

/**
 * Debounced persistence of the prompt draft. `schedule` coalesces rapid
 * edits into one call after the debounce window; `flush` reports right away
 * (blur, or right after sending, so an empty draft can't reappear if the app
 * dies in the gap). `onChange` is read through a ref because callers invoke
 * these from outside React's render cycle (editor callbacks, native events).
 * A pending timer is dropped on unmount.
 */
export function useDraftSync(onChange: ((text: string) => void) | undefined): {
  schedule: (text: string) => void;
  flush: (text: string) => void;
} {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timerRef = useRef<number | undefined>(undefined);

  const schedule = useCallback((text: string) => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onChangeRef.current?.(text), DRAFT_DEBOUNCE_MS);
  }, []);

  const flush = useCallback((text: string) => {
    window.clearTimeout(timerRef.current);
    onChangeRef.current?.(text);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { schedule, flush };
}
