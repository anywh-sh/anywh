import type { IntegrationProvider } from "@/lib/integrations/model";
import { cn } from "@/lib/utils";

/** The providers' official marks, from simple-icons (CC0 1.0,
 * https://simpleicons.org), on a 24x24 box. */
const MARK: Record<IntegrationProvider, string> = {
  jira: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
};

/** The brand color a provider's mark is drawn in by default. A provider
 * without one stays monochrome (`currentColor`), like the lucide icons
 * beside it in the rail. */
const BRAND_COLOR: Partial<Record<IntegrationProvider, string>> = {
  jira: "#0052CC",
};

/** An integration's mark, in its brand color when it has one. The color is
 * the `fill` itself, so a caller's `text-*` class does not repaint it;
 * `monochrome` opts back into `currentColor`. */
export function IntegrationIcon({ provider, className, monochrome = false }: { provider: IntegrationProvider; className?: string; monochrome?: boolean }) {
  const fill = (monochrome ? undefined : BRAND_COLOR[provider]) ?? "currentColor";
  return (
    <svg viewBox="0 0 24 24" fill={fill} aria-hidden="true" data-integration-icon={provider} className={cn("size-4", className)}>
      <path d={MARK[provider]} />
    </svg>
  );
}
