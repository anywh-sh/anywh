import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Lockup } from "@/components/firstrun/Lockup";
import { QuietLink } from "@/components/firstrun/QuietLink";
import { Stepper, type StepperStep } from "@/components/firstrun/Stepper";
import { LanguageControl } from "@/components/shell/LanguageControl";
import { MAC_TRAFFIC_LIGHTS_INSET, WindowControls } from "@/components/shell/WindowControls";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/install/appVersion";
import { isMacOS } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

/** Where Help leads: the self-hosting guide, the one document that covers
 * every path the onboarding offers. */
export const ONBOARDING_HELP_URL = "https://github.com/anywh-sh/anywh/blob/main/docs/self-hosting.md";

/** The dot grid under the content, drawn from the same `--canvas-grid` token
 * as the room canvas and faded toward the edges so it never reaches the
 * window's border. */
const GRID_STYLE = {
  backgroundImage: "radial-gradient(circle, var(--canvas-grid) 1px, transparent 1.5px)",
  backgroundSize: "24px 24px",
  maskImage: "radial-gradient(ellipse at center, black 30%, transparent 85%)",
} as const;

/**
 * The window every onboarding screen is drawn in: the title bar (the shell's
 * `TitleBar` isn't mounted before a profile exists), a bordered plane with a
 * dot grid, a 560px column, and a footer with Help, the language and the
 * version. A screen supplies only its content, plus `steps`/`current` when
 * the header should show progress and `onBack` when there is somewhere to go
 * back to.
 */
export function OnboardingFrame({
  children,
  steps,
  current,
  onBack,
  large = false,
  className,
}: {
  children: ReactNode;
  steps?: StepperStep[];
  current?: string;
  onBack?: () => void;
  /** The Welcome screen's bigger lockup. */
  large?: boolean;
  className?: string;
}) {
  const dict = useDict();
  const copy = dict.firstRun;

  return (
    <div className="flex h-full w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className={cn("flex h-10 shrink-0 select-none border-b border-border bg-bg-chrome", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}>
        {/* Mirrors `WindowControls`' width on the other side so the title
         * centers on the bar itself, not on whatever's left after it. */}
        <div className="invisible" aria-hidden="true">
          <WindowControls />
        </div>
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-center px-2">
          <span className="pointer-events-none font-mono text-[11.5px] text-text-faint">{copy.windowTitle}</span>
        </div>
        <WindowControls />
      </div>

      <div className="relative m-3 flex min-h-0 flex-1 flex-col border border-border-soft bg-bg-sidebar">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={GRID_STYLE} />
        <div className="scrollbar-thin relative flex min-h-0 flex-1 justify-center overflow-y-auto">
          {/* `my-auto` rather than `items-center` on the scroll container:
           * auto margins collapse to zero instead of clipping the top of the
           * content once it's taller than the window. */}
          <div className="my-auto flex w-full max-w-[560px] flex-col gap-10 px-6 py-10">
            <header className="flex min-h-7 items-center gap-4">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex h-7 cursor-pointer items-center gap-1 text-[13px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline"
                >
                  <ChevronLeft className="size-3.5" aria-hidden="true" />
                  {copy.frame.back}
                </button>
              )}
              <Lockup large={large} />
              <div className="flex-1" />
              {steps && current && <Stepper steps={steps} current={current} />}
            </header>
            <main className={cn("flex flex-col gap-8", className)}>{children}</main>
          </div>
        </div>
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-3 px-4 font-mono text-[10.5px] text-text-faint">
        <QuietLink href={ONBOARDING_HELP_URL} className="font-mono text-[10.5px]">
          {copy.frame.help}
        </QuietLink>
        <div className="flex-1" />
        <LanguageControl />
        <span title={dict.shell.statusBar.appVersion.replace("{version}", APP_VERSION)}>v{APP_VERSION}</span>
      </footer>
    </div>
  );
}
