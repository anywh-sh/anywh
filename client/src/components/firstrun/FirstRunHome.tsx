import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { useDict } from "@/i18n";
import type { FirstRunScreen } from "@/lib/firstRun";

function PathCard({ number, title, hint, onClick }: { number: string; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-3.5 border border-border bg-bg-sidebar px-4 py-[15px] text-left transition-colors hover:border-text-faint"
    >
      <span className="shrink-0 pt-[3px] font-mono text-[10.5px] font-medium text-primary">{number}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[15px] font-medium text-foreground">{title}</span>
        <span className="text-[13px] leading-[1.6] text-pretty text-text-faint">{hint}</span>
      </span>
    </button>
  );
}

/**
 * The choice of paths. Two for now — reach a relay that already exists, by
 * address or by pairing code — plus the terminal for whoever has no relay
 * anywhere yet. Installing one from inside the app is a third path that
 * isn't built yet; when it lands it takes the first slot and these two move
 * down, which is why the numbers are data and not part of the copy.
 */
export function FirstRunHome({ onPick }: { onPick: (screen: FirstRunScreen) => void }) {
  const copy = useDict().firstRun.home;

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />
      <div className="flex flex-col gap-2">
        <PathCard number="01" title={copy.connectTitle} hint={copy.connectHint} onClick={() => onPick("connect")} />
        <PathCard number="02" title={copy.codeTitle} hint={copy.codeHint} onClick={() => onPick("code")} />
      </div>
      <div className="flex items-center gap-2 font-mono text-xs text-text-faint">
        <span>{copy.terminalPrompt}</span>
        <button
          type="button"
          onClick={() => onPick("manual")}
          className="cursor-pointer border-b border-primary-soft text-primary transition-colors hover:text-primary-ink"
        >
          {copy.terminalLink}
        </button>
      </div>
    </>
  );
}
