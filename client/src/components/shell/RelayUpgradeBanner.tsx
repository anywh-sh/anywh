import { CheckCircle2, RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLegacyRelayUpgrade, type LegacyUpgradeState } from "@/hooks/relay/useLegacyRelayUpgrade";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";

/** How long the "up to date" line stays before the notice goes away. */
export const DONE_NOTICE_MS = 4000;

function progressText(state: LegacyUpgradeState, dict: ReturnType<typeof useDict>["shell"]["relayUpgrade"]): string | null {
  switch (state.phase) {
    case "checking":
      return dict.checking;
    case "waiting":
      return state.busy === 1 ? dict.waitingOne : dict.waitingMany.replace("{count}", String(state.busy));
    case "updating":
      return dict.updating;
    case "restarting":
      return dict.restarting;
    case "hidden":
    case "available":
    case "done":
    case "not_published":
    case "failed":
      return null;
  }
}

/**
 * What the notice shows for one profile's relay, given where the update
 * stands — no fetching here, so every state renders on its own (stories).
 */
export function RelayUpgradeNotice({
  profileLabel,
  state,
  eachTime = false,
  onUpdate,
  onDismiss,
}: {
  profileLabel: string;
  state: LegacyUpgradeState;
  /** The relay needs this with every release (Homebrew). */
  eachTime?: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  const dict = useDict().shell.relayUpgrade;
  if (state.phase === "hidden") return null;
  const [before, after = ""] = (eachTime ? dict.bodyEachTime : dict.body).split("{profile}");
  const progress = progressText(state, dict);

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border bg-bg-sidebar px-4 py-3" data-testid="relay-upgrade-notice">
      {state.phase === "done" ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
      ) : (
        <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-[10.5px] tracking-[0.11em] text-muted-foreground uppercase">{dict.eyebrow}</span>
        {state.phase === "done" ? (
          <span className="text-[13px] leading-relaxed text-foreground">{dict.done}</span>
        ) : (
          <span className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
            {before}
            <span className="font-mono text-xs text-foreground">{profileLabel}</span>
            {after}
          </span>
        )}
        {progress && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner size="sm" />
            {progress}
          </span>
        )}
        {state.phase === "not_published" && <span className="text-xs text-muted-foreground">{dict.notPublished}</span>}
        {state.phase === "failed" && (
          <div className="flex flex-col gap-1 pt-1">
            <span className="text-xs text-destructive">{dict.failedReasons[state.reason]}</span>
            {state.detail && <span className="font-mono text-[11px] text-muted-foreground">{state.detail}</span>}
            <span className="text-xs text-muted-foreground">{dict.runThere}</span>
            <code className="border border-border bg-bg-chrome px-2 py-1 font-mono text-[11px] break-all text-foreground select-all">
              {state.command}
            </code>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {(state.phase === "available" || state.phase === "not_published" || state.phase === "failed") && (
          <Button variant="outline" size="sm" onClick={onUpdate}>
            {dict.update}
          </Button>
        )}
        {/* Checking or waiting can be called off; an update already running cannot. */}
        {state.phase !== "updating" && state.phase !== "restarting" && (
          <Button variant="ghost" size="icon-sm" aria-label={dict.dismiss} onClick={onDismiss}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The update as a compact control, for the places that offer it next to
 * other things (a profile's settings, the bots section): the button, what
 * it is doing, or why it stopped — the same run the notice shows.
 */
export function RelayUpgradeAction({ state, onUpdate, align = "end" }: { state: LegacyUpgradeState; onUpdate: () => void; align?: "start" | "end" }) {
  const dict = useDict().shell.relayUpgrade;
  const progress = progressText(state, dict);
  const items = align === "end" ? "items-end text-right" : "items-start";
  if (state.phase === "hidden") return null;
  if (progress) {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Spinner size="sm" />
        {progress}
      </span>
    );
  }
  if (state.phase === "done") return <span className="text-xs text-muted-foreground">{dict.done}</span>;
  return (
    <div className={`flex flex-col gap-1.5 ${items}`}>
      <Button variant="outline" size="sm" onClick={onUpdate}>
        {dict.update}
      </Button>
      {state.phase === "not_published" && <span className="text-xs text-muted-foreground">{dict.notPublished}</span>}
      {state.phase === "failed" && (
        <>
          <span className="text-xs text-destructive">{dict.failedReasons[state.reason]}</span>
          {state.detail && <span className="font-mono text-[11px] text-muted-foreground">{state.detail}</span>}
          <span className="text-xs text-muted-foreground">{dict.runThere}</span>
          <code className="border border-border bg-bg-chrome px-2 py-1 text-left font-mono text-[11px] break-all text-foreground select-all">{state.command}</code>
        </>
      )}
    </div>
  );
}

/** The notice for one profile, driven by its relay. */
export function RelayUpgradeBanner({ profile }: { profile: Profile }) {
  const { state, noticeDismissed, eachTime, start, dismiss } = useLegacyRelayUpgrade(profile, { source: "banner" });
  useEffect(() => {
    if (state.phase !== "done") return;
    const timer = setTimeout(dismiss, DONE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, dismiss]);
  if (noticeDismissed) return null;
  return <RelayUpgradeNotice profileLabel={profile.label} state={state} eachTime={eachTime} onUpdate={start} onDismiss={dismiss} />;
}

/** One notice per profile whose relay needs the update — every profile, not
 * just the active one, same as `RevokedProfileBanners`. */
export function RelayUpgradeBanners() {
  const profiles = useProfiles();
  return (
    <>
      {profiles.map((profile) => (
        <RelayUpgradeBanner key={profile.id} profile={profile} />
      ))}
    </>
  );
}
