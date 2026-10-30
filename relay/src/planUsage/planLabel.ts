// Plan type → UI label (journal/99 §3A). Claude's base is `claude auth
// status` → `subscriptionType`, refined for Max by the undocumented rate
// limit tiers in `~/.claude.json` (read by key elsewhere; only the tier
// strings reach this module). Codex's is `account/read` → `planType`, an
// enum that grows between CLI versions — so an unknown value is shown as is,
// capitalized, never dropped.
//
// Pure: no I/O.
import type { PlanLabel } from "./types.js";

export interface ClaudePlanInput {
  /** `claude auth status` → `subscriptionType`. */
  subscriptionType?: string | null;
  /** `claude auth status` → `authMethod`. When present and not `claude.ai`
   * (API key, Bedrock…), there is no plan. */
  authMethod?: string | null;
  /** `~/.claude.json` → `oauthAccount.userRateLimitTier`. */
  userRateLimitTier?: string | null;
  /** `~/.claude.json` → `oauthAccount.organizationRateLimitTier`. */
  organizationRateLimitTier?: string | null;
}

const CLAUDE_LABELS: Readonly<Record<string, string>> = {
  max: "Max",
  pro: "Pro",
  // No "Premium" suffix in the first cut: standard vs premium is unverified (D9c).
  team: "Team",
  enterprise: "Enterprise",
};

const CODEX_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** `"new_plan"` → `"New Plan"`: the fallback for a value no table knows. */
export function capitalizePlanValue(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The Max variant a tier string names, if any. */
function maxVariant(tier: string | null): string | null {
  if (!tier) return null;
  if (tier.includes("max_20x")) return "Max 20x";
  if (tier.includes("max_5x")) return "Max 5x";
  return null;
}

/** Claude's plan label; undefined when there is no plan to show (not a
 * claude.ai login, or no `subscriptionType`). The user tier wins over the
 * organization's when both name a variant. */
export function claudePlanLabel(input: ClaudePlanInput): PlanLabel | undefined {
  const authMethod = normalize(input.authMethod);
  if (authMethod !== null && authMethod !== "claude.ai") return undefined;
  const family = normalize(input.subscriptionType);
  if (!family) return undefined;
  if (family === "max") {
    const variant = maxVariant(normalize(input.userRateLimitTier)) ?? maxVariant(normalize(input.organizationRateLimitTier));
    if (variant) return { family, label: variant, variantSource: "claude_json_tier" };
  }
  return { family, label: CLAUDE_LABELS[family] ?? capitalizePlanValue(family) };
}

/** Codex's plan label from `planType`; undefined for null or `unknown`. */
export function codexPlanLabel(planType: string | null | undefined): PlanLabel | undefined {
  const family = normalize(planType);
  if (!family || family === "unknown") return undefined;
  const label =
    CODEX_LABELS[family] ??
    (family.startsWith("self_serve_business_") ? "Business" : undefined) ??
    (family.startsWith("enterprise") || family === "ent26" ? "Enterprise" : undefined) ??
    capitalizePlanValue(family);
  return { family, label };
}
