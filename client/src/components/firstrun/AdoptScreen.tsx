import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import type { LocalRelayProbe } from "@/lib/localRelay";
import { currentPlatform } from "@/lib/platform";
import { addProfile, profileColorClassForIndex, type Profile } from "@/lib/profiles";
import { resumeProfileSetup } from "@/lib/profileSetup";
import { cn } from "@/lib/utils";

/**
 * A relay with registered profiles already lives on this machine: list
 * them and adopt them, installing and creating nothing. Adopted profiles
 * are saved `unverified` and the first one is handed to the same
 * verification every other path uses — the shell's session sync clears
 * the rest once it reaches them. A `default.env` the registry doesn't know
 * is shown as what it is (a stray relay run's leftover), never adopted.
 */
export function AdoptScreen({ probe, onCreateAnother }: { probe: LocalRelayProbe; onCreateAnother: () => void }) {
  const copy = useDict().firstRun.adopt;
  const registered = probe.profiles.filter((p) => p.registered);
  const orphan = probe.profiles.find((p) => p.id === "default" && !p.registered);
  // The in-app installer's macOS path (app-install.sh) always provisions the
  // id "default" — there's no second relay to create here, unlike Linux's
  // systemd template. Offering the button anyway just walks the user into
  // add-profile.sh's --resume rejecting a host that doesn't match the one
  // already on disk.
  const canCreateAnother = currentPlatform() !== "macos";

  function adopt(): void {
    const profiles: Profile[] = registered.map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      host: p.host ?? "127.0.0.1",
      relayPort: p.port ?? 8765,
      localRelay: true,
      unverified: true,
    }));
    for (const profile of profiles) addProfile(profile);
    if (profiles[0]) resumeProfileSetup(profiles[0]);
  }

  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body.replace("{count}", String(registered.length))} />
      <ul className="border border-border bg-bg-sidebar">
        {registered.map((p, index) => (
          <li key={p.id} className="flex items-center gap-3 border-b border-border-soft px-4 py-3 last:border-b-0">
            <span className={cn("size-2 shrink-0", profileColorClassForIndex(index))} aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-mono text-[13px] font-medium text-foreground">{p.label ?? p.id}</span>
              <span className="font-mono text-[11.5px] text-text-faint">
                {copy.rowMeta.replace("{host}", p.host ?? "127.0.0.1").replace("{port}", String(p.port ?? ""))}
              </span>
            </span>
          </li>
        ))}
        {orphan && (
          <li className="flex items-center gap-3 border-t border-border-soft px-4 py-3 opacity-70">
            <span className="size-2 shrink-0 border border-border" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-mono text-[13px] text-muted-foreground">default.env</span>
              <span className="font-mono text-[11.5px] text-text-faint">{copy.orphanNote}</span>
            </span>
          </li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="button" onClick={adopt} disabled={registered.length === 0}>
          {registered.length === 1 ? copy.adoptOne : copy.adopt.replace("{count}", String(registered.length))}
        </Button>
        {canCreateAnother && (
          <Button type="button" variant="outline" onClick={onCreateAnother}>
            {copy.createAnother}
          </Button>
        )}
      </div>
      {!canCreateAnother && <p className="text-[12.5px] text-text-faint">{copy.macNote}</p>}
    </>
  );
}
