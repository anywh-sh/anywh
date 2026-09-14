import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { useDict } from "@/i18n";

/** The recognition step — on screen only while the probe runs, which is a
 * filesystem read and usually over before the eye lands on it. */
export function DetectScreen() {
  const copy = useDict().firstRun.detect;
  return (
    <>
      <FirstRunHeading title={copy.title} body={copy.body} />
      <div className="h-0.5 w-full overflow-hidden bg-border-soft" aria-hidden="true">
        <span className="animate-turn-sweep block h-full w-1/3 bg-primary" />
      </div>
    </>
  );
}
