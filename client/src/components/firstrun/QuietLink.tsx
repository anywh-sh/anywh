import type { ButtonHTMLAttributes } from "react";
import { ChevronRight } from "lucide-react";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";
import { cn } from "@/lib/utils";

const QUIET =
  "inline-flex cursor-pointer items-center gap-1 text-[13px] text-text-faint outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline";

/**
 * The grey link of the onboarding. `Button variant="link"` is the accent
 * color, which on this screen is reserved for the mark and the `$`; a
 * secondary way out ("the agent runs on another machine?") must not compete
 * with the one primary action. With `href` it is an external link opened in
 * the system browser; without, a button with a trailing chevron.
 */
export function QuietLink(
  props:
    | ({ href: string } & { children: React.ReactNode; className?: string })
    | ({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>),
) {
  if (props.href !== undefined) {
    const { href, children, className } = props;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => handleExternalLinkClick(event, href)}
        className={cn(QUIET, "underline underline-offset-4", className)}
      >
        {children}
      </a>
    );
  }
  const { children, className, type = "button", ...rest } = props;
  return (
    <button type={type} className={cn(QUIET, className)} {...rest}>
      {children}
      <ChevronRight className="size-3.5" aria-hidden="true" />
    </button>
  );
}
