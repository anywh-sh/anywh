import { useId } from "react";

/**
 * The mark: a filled accent square with a chevron and a bar cut out of it.
 *
 * Both colors are literal hex, matching `assets/logo.svg` (the static brand
 * asset) exactly — deliberately not `--primary`/`--primary-foreground`,
 * which are the *active theme's* accent and vary with it (`--primary` alone
 * differs between the two built-in themes). The mark is brand identity, not
 * UI chrome: it stays the same two colors regardless of which theme is on
 * screen, the same way the mark doesn't take `currentColor` either — a mark
 * that recolored with its surroundings would stop being the mark.
 */
export function AnywhLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" fill="#c2440f" />
      <path
        d="M10.6 8.7L18.2 16l-7.6 7.3"
        fill="none"
        stroke="#fdf1e8"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="22.5" y="11.3" width="4.4" height="9.4" rx="2.2" fill="#fdf1e8" />
    </svg>
  );
}

/**
 * The mark's shape alone, for a backdrop rather than for identity: one flat
 * colour (`currentColor`) with the chevron and the bar cut out, so what is
 * behind it shows through them. Where the mark stands for the brand, it is
 * `AnywhLogo`, in its own colours.
 */
export function AnywhMarkSilhouette({ className }: { className?: string }) {
  const maskId = useId();
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <mask id={maskId}>
        <rect width="32" height="32" fill="#fff" />
        <path d="M10.6 8.7L18.2 16l-7.6 7.3" fill="none" stroke="#000" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="22.5" y="11.3" width="4.4" height="9.4" rx="2.2" fill="#000" />
      </mask>
      <rect width="32" height="32" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}

/**
 * The lockup — mark plus wordmark. `anywh.sh` (with the dot) is the wordmark
 * form, which is what belongs beside the mark; the bare `anywh` noun is for
 * prose and identifiers, and the two are not interchangeable.
 */
export function AnywhLockup({ className }: { className?: string }) {
  return (
    <span className={className}>
      <AnywhLogo className="size-[18px] shrink-0" />
      <span className="truncate font-mono text-[length:calc(13px*var(--font-scale-ratio))] font-semibold tracking-[-0.02em] text-foreground">anywh.sh</span>
    </span>
  );
}
