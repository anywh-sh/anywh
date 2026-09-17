import { useEffect, useRef, useState } from "react";
import { FirstRunHeading } from "@/components/firstrun/FirstRunHeading";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import { currentPlatform } from "@/lib/platform/platform";

interface Step {
  label: string;
  command: string;
}

function CommandRow({ step }: { step: Step }) {
  const copy = useDict().firstRun.copy;
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(step.command);
      setState("copied");
    } catch {
      // The clipboard can refuse (no permission, no secure context). Said in
      // the button itself — `window.alert` is unreliable in these webviews.
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }

  return (
    <li className="flex flex-col gap-1.5 border-b border-border-soft px-3.5 py-3 last:border-b-0">
      <span className="font-mono text-[10px] font-medium tracking-[0.14em] text-text-faint uppercase">{step.label}</span>
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 pt-px font-mono text-[11.5px] text-primary" aria-hidden="true">
          $
        </span>
        <code className="selectable-content min-w-0 flex-1 font-mono text-[12.5px] leading-[1.7] break-words whitespace-pre-wrap text-foreground">
          {step.command}
        </code>
        <Button type="button" variant="outline" size="xs" onClick={() => void handleCopy()} className="shrink-0">
          {state === "copied" ? copy.copied : state === "failed" ? copy.failed : copy.copy}
        </Button>
      </div>
    </li>
  );
}

/**
 * The terminal alternative: the same install the app will eventually run
 * for you, spelled out. Commands come from the docs rather than being
 * generated — `curl | sh` for Linux (and WSL2 on Windows), the Homebrew
 * formula on macOS, where `install.sh` has no service manager to drive.
 * `onDone` hands over to path 01 pointed at loopback, since a relay
 * installed by following this screen is on this very machine. Getting back
 * to the paths without finishing is the header's "back" — the one already
 * on screen for every non-home screen — so this doesn't repeat it.
 */
export function ManualInstructions({ onDone }: { onDone: () => void }) {
  const copy = useDict().firstRun.manual;
  const platform = currentPlatform();
  const relayHost = `<${copy.relayHostPlaceholder}>`;

  const steps: Step[] =
    platform === "macos"
      ? [
          { label: copy.install, command: "brew install anywh-sh/tap/anywh-relay" },
          {
            label: copy.profile,
            command: `"$(brew --prefix anywh-relay)/libexec/infra/systemd/add-profile.sh" default --mode dev --relay-host ${relayHost}`,
          },
          { label: copy.start, command: "brew services start anywh-relay" },
        ]
      : [
          { label: copy.install, command: "curl -fsSL https://anywh.sh/install | sh" },
          { label: copy.profile, command: `~/.local/share/anywh/infra/systemd/add-profile.sh default --relay-host ${relayHost}` },
        ];

  const body = platform === "macos" ? copy.bodyMac : platform === "windows" ? copy.bodyWindows : copy.body;

  return (
    <>
      <FirstRunHeading title={copy.title} body={body} />
      <ol className="border border-border bg-bg-chrome">
        {steps.map((step) => (
          <CommandRow key={step.label} step={step} />
        ))}
      </ol>
      <div className="flex flex-wrap gap-2.5">
        <Button type="button" onClick={onDone}>
          {copy.done}
        </Button>
      </div>
    </>
  );
}
