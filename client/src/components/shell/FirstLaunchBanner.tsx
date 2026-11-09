import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTelemetryConsent } from "@/hooks/useTelemetryConsent";
import { useDict } from "@/i18n";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";

/** The page that lists every event the app can send. */
export const TELEMETRY_DOCS_URL = "https://anywh.sh/docs/telemetry";

/**
 * The one question the app asks, once: may it count which features get used.
 * It sits over the window's lower-left corner, out of the way of the work, and
 * stays until it is answered.
 *
 * "Got it" and the close button both accept — the copy says what is counted
 * and that nothing of the user's work is in it, and a banner that can only be
 * dismissed by choosing is not a notice. "Don't share" is the way out, and
 * it is as large as the way in. Nothing is sent before either is pressed
 * (`telemetry/client.ts` holds events until then).
 *
 * `role="region"`, not a dialog: it does not trap focus or block the app.
 */
export function FirstLaunchBanner() {
  const copy = useDict().shell.telemetryBanner;
  const { bannerVisible, accept, decline } = useTelemetryConsent();
  if (!bannerVisible) return null;

  return (
    <section
      aria-label={copy.title}
      className="fixed bottom-9 left-3 z-50 flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-3 border border-border bg-popover p-4 text-popover-foreground shadow-popover"
    >
      <button
        type="button"
        onClick={accept}
        aria-label={copy.close}
        className="absolute top-2.5 right-2.5 inline-flex size-6 cursor-pointer items-center justify-center text-text-faint transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        <X className="size-3.5" />
      </button>
      <h2 className="pr-6 font-display text-[15px] leading-snug font-bold tracking-[-0.01em] text-balance text-foreground">{copy.title}</h2>
      <p className="text-xs leading-relaxed text-pretty text-muted-foreground">{copy.body}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={accept}>
          {copy.gotIt}
        </Button>
        <Button variant="outline" size="sm" onClick={() => decline("banner")}>
          {copy.dontShare}
        </Button>
        <div className="flex-1" />
        <a
          href={TELEMETRY_DOCS_URL}
          onClick={(event) => handleExternalLinkClick(event, TELEMETRY_DOCS_URL)}
          className="font-mono text-[10.5px] whitespace-nowrap text-text-faint underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
        >
          {copy.learnMore}
        </a>
      </div>
    </section>
  );
}
