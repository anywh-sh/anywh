import type { IntegrationProvider } from "@/lib/integrations/model";
import { cn } from "@/lib/utils";

/**
 * An integration's mark, in the rail's own line style (`currentColor`, the
 * stroke of the lucide icons beside it) rather than the provider's logo: a
 * diamond with a dot for Jira, a slanted square for Linear.
 */
export function IntegrationIcon({ provider, className }: { provider: IntegrationProvider; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
      aria-hidden="true"
      data-integration-icon={provider}
      className={cn("size-4", className)}
    >
      {provider === "jira" ? (
        <>
          <path d="M12 3 21 12 12 21 3 12Z" />
          <path d="M12 9.5 14.5 12 12 14.5 9.5 12Z" fill="currentColor" />
        </>
      ) : (
        <path d="M5 8 16 3l3 13-11 5Z" />
      )}
    </svg>
  );
}
