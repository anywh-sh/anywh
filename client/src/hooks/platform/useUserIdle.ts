import { useEffect, useRef, useState } from "react";

/** Input that counts as someone being at the machine. Passive: none of it is
 * ever prevented. */
const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;

/**
 * `true` once `timeoutMs` has passed with no input on the window, `false` again
 * on the next input. DOM events and a timer only — nothing native — so it
 * costs nothing while the person is typing: each event just records when it
 * happened, and a single timer checks how long ago that was.
 *
 * `enabled: false` reports `false` and listens to nothing (a phone's screen
 * being on is already a statement that someone is there).
 */
export function useUserIdle(timeoutMs: number, enabled = true): boolean {
  const [idle, setIdle] = useState(false);
  const lastActivity = useRef(Date.now());
  const idleRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      return;
    }
    lastActivity.current = Date.now();
    idleRef.current = false;
    setIdle(false);

    let timer: number | undefined;
    const arm = (delay: number) => {
      timer = window.setTimeout(check, delay);
    };
    function check(): void {
      const remaining = timeoutMs - (Date.now() - lastActivity.current);
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      idleRef.current = true;
      setIdle(true);
    }
    const onActivity = () => {
      lastActivity.current = Date.now();
      if (!idleRef.current) return;
      idleRef.current = false;
      setIdle(false);
      arm(timeoutMs);
    };

    arm(timeoutMs);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
    };
  }, [timeoutMs, enabled]);

  return enabled && idle;
}
