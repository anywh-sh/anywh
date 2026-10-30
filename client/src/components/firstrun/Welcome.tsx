import { ArrowRight, ArrowUpRight } from "lucide-react";
import { OnboardingFrame } from "@/components/firstrun/OnboardingFrame";
import { QuietLink } from "@/components/firstrun/QuietLink";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";

const WSL_INSTALL_URL = "https://learn.microsoft.com/windows/wsl/install";
const AGENT_INSTALL_URL = "https://code.claude.com/docs/en/setup";

/**
 * The first screen on a desktop: what anywh is, one way in ("set up on this
 * machine") and one way around it ("the agent runs on another machine?").
 *
 * Windows has no in-app install — anywh and the agents live in WSL2 — so
 * the variant says that up front, lists the two things to have (static:
 * nothing is detected from here) and leads to the terminal instructions.
 * Inside a sandbox (`container`) the in-app install can't reach the
 * machine either, and the same terminal path is offered instead.
 */
export function Welcome({
  windows = false,
  container = null,
  onSetUp,
  onTerminal,
  onOtherMachine,
}: {
  windows?: boolean;
  container?: string | null;
  onSetUp: () => void;
  onTerminal: () => void;
  onOtherMachine: () => void;
}) {
  const dict = useDict();
  const copy = dict.firstRun.welcome;

  return (
    <OnboardingFrame large>
      <section className="flex flex-col gap-4">
        <h1 className="max-w-[22ch] font-display text-[length:calc(36px*var(--font-scale-ratio))] leading-[1.15] font-bold tracking-[-0.035em] text-balance text-foreground">
          {copy.title}
        </h1>
        <p className="max-w-[60ch] text-[length:calc(15px*var(--font-scale-ratio))] leading-[1.7] text-pretty text-muted-foreground">{copy.body}</p>
      </section>

      {windows ? (
        <section className="flex flex-col gap-4">
          <p role="note" className="border border-border-soft bg-bg-chrome px-4 py-3 text-[length:calc(13.5px*var(--font-scale-ratio))] leading-[1.65] text-pretty text-foreground">
            {copy.windows.notice}
          </p>
          <ol className="border border-border-soft bg-bg-chrome">
            <WindowsStep number={1} title={copy.windows.steps.wsl.title} link={copy.windows.steps.wsl.link} href={WSL_INSTALL_URL} />
            <WindowsStep number={2} title={copy.windows.steps.agent.title} link={copy.windows.steps.agent.link} href={AGENT_INSTALL_URL} />
          </ol>
          <Button type="button" size="lg" onClick={onTerminal} className="gap-2 self-start">
            {copy.windows.cta}
            <ArrowRight aria-hidden="true" />
          </Button>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <Button type="button" size="lg" onClick={onSetUp} disabled={container !== null} className="gap-2 self-start">
            {copy.cta}
            <ArrowRight aria-hidden="true" />
          </Button>
          {container === null ? (
            <p className="font-mono text-[length:calc(11.5px*var(--font-scale-ratio))] text-text-faint">{copy.ctaHint}</p>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="max-w-[60ch] text-[length:calc(13px*var(--font-scale-ratio))] leading-[1.6] text-pretty text-muted-foreground">
                {copy.container.replace("{container}", container)}
              </p>
              <QuietLink onClick={onTerminal}>{copy.containerTerminal}</QuietLink>
            </div>
          )}
        </section>
      )}

      <div className="border-t border-border-soft pt-5">
        <QuietLink onClick={onOtherMachine}>{copy.otherMachine}</QuietLink>
      </div>
    </OnboardingFrame>
  );
}

function WindowsStep({ number, title, link, href }: { number: number; title: string; link: string; href: string }) {
  return (
    <li className="flex items-center gap-3.5 border-b border-border-soft px-4 py-3.5 last:border-b-0">
      <span className="flex size-5 shrink-0 items-center justify-center border border-border font-mono text-[length:calc(11px*var(--font-scale-ratio))] text-muted-foreground">
        {number}
      </span>
      <span className="min-w-0 flex-1 text-[length:calc(14px*var(--font-scale-ratio))] text-foreground">{title}</span>
      <QuietLink href={href} className="no-underline">
        {link}
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </QuietLink>
    </li>
  );
}
