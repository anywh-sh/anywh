import { AnywhMarkSilhouette } from "@/components/shell/AnywhLogo";
import { useDict } from "@/i18n";

/** The dot grid behind it, drawn from the same `--canvas-grid` token as the
 * room canvas and the onboarding, faded toward the edges so it never reaches
 * the panel's border. */
const GRID_STYLE = {
  backgroundImage: "radial-gradient(circle, var(--canvas-grid) 1px, transparent 1.5px)",
  backgroundSize: "24px 24px",
  maskImage: "radial-gradient(ellipse at center, black 30%, transparent 85%)",
} as const;

/**
 * What the side panel draws when it is open but nothing was picked in it: the
 * mark's shape, quiet, over a dot grid on the chrome's colour (the status
 * bar's and the sidebar's), and a prompt to choose a view from the rail. It is the
 * dock's "no selection" pane (`none`), so a view added to the panel later is
 * chosen from here without the panel having to guess a default.
 */
export function DockEmptyState() {
  const dict = useDict();
  return (
    <div data-testid="dock-empty-state" className="relative flex h-full w-full items-center justify-center bg-bg-chrome p-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={GRID_STYLE} />
      <div className="relative flex flex-col items-center gap-4 text-center">
        <AnywhMarkSilhouette className="size-14 text-border" />
        <p className="text-sm text-muted-foreground">{dict.panels.noSelection}</p>
      </div>
    </div>
  );
}
