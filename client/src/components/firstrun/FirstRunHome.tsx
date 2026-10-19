import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { useDict } from "@/i18n";
import type { FirstRunScreen } from "@/lib/profiles/firstRun";
import { cn } from "@/lib/utils";

function PathCard({
  number,
  title,
  hint,
  tag,
  disabled = false,
  onClick,
}: {
  number: string;
  title: string;
  hint: string;
  tag?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-3.5 border border-border bg-bg-sidebar px-4 py-[15px] text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-text-faint",
      )}
    >
      <span className="shrink-0 pt-[3px] font-mono text-[10.5px] font-medium text-primary">{number}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[15px] font-medium text-foreground">{title}</span>
        <span className="text-[13px] leading-[1.6] text-pretty text-text-faint">{hint}</span>
      </span>
      {tag && <span className="shrink-0 border border-border-soft px-1.5 py-0.5 font-mono text-[10px] text-text-faint">{tag}</span>}
    </button>
  );
}

/** Whether the "set up on this machine" card is offered: not at all on a
 * platform without the in-app install (Windows, the browser), or
 * shown-but-disabled with the reason inside a sandbox that can't reach the
 * host's service manager. */
export type LocalPathAvailability = { kind: "hidden" } | { kind: "available" } | { kind: "unavailable"; reason: string };

/**
 * The choice of paths: install a relay here (Linux or macOS), reach one that
 * already exists by address or by pairing code, or the terminal for whoever
 * wants the same steps typed. The numbers are data, not copy — they shift
 * when the first card isn't there.
 */
export function FirstRunHome({ onPick, local }: { onPick: (screen: FirstRunScreen) => void; local: LocalPathAvailability }) {
  const copy = useDict().firstRun.home;
  const offset = local.kind === "hidden" ? 0 : 1;
  const number = (index: number) => `0${index + offset}`;

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />
      <div className="flex flex-col gap-2">
        {local.kind !== "hidden" && (
          <PathCard
            number="01"
            title={copy.localTitle}
            hint={copy.localHint}
            tag={local.kind === "unavailable" ? local.reason : undefined}
            disabled={local.kind === "unavailable"}
            onClick={() => onPick("local")}
          />
        )}
        <PathCard number={number(1)} title={copy.connectTitle} hint={copy.connectHint} onClick={() => onPick("connect")} />
        <PathCard number={number(2)} title={copy.codeTitle} hint={copy.codeHint} onClick={() => onPick("code")} />
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
