import { useEffect, useState } from "react";

/** Used before the native composer has reported its real size. */
export const FALLBACK_NATIVE_BOTTOM_INSET = 96;

const VAR = "--native-bottom-inset";

function read(): number {
  const parsed = Number.parseFloat(document.documentElement.style.getPropertyValue(VAR));
  return Number.isFinite(parsed) ? parsed : FALLBACK_NATIVE_BOTTOM_INSET;
}

/** The height (px) the native composer and its strip take at the bottom of
 * the screen, keyboard included. The native side writes it as a CSS variable
 * on the root; this follows it. */
export function useNativeBottomInset(): number {
  const [inset, setInset] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setInset(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    setInset(read());
    return () => observer.disconnect();
  }, []);
  return inset;
}
