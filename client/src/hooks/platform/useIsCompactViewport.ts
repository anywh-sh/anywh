import { useEffect, useState } from "react";

const BREAKPOINT = 720;

export function useIsCompactViewport(): boolean {
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < BREAKPOINT);

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${BREAKPOINT - 1}px)`);
    const update = (): void => setIsCompact(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isCompact;
}
