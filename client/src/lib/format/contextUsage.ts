import type { ContextUsage } from "@/lib/relay/relayClient";

// Thresholds borrowed from Claude Code's official statusline convention
// (green <70%, yellow 70–89%, red >=90% — code.claude.com/docs/en/statusline)
// but used here as continuous transition points (color-mix), not solid
// bands — see ContextUsageRing.
const WARN_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;

export function contextUsagePercent(usage: ContextUsage): number {
  if (usage.contextWindowSize <= 0) return 0;
  return Math.min(100, Math.max(0, (usage.usedTokens / usage.contextWindowSize) * 100));
}

/**
 * Ring/bar color for a usage %, always derived from CSS variables via
 * `color-mix()` — never a fixed hex. 0–70%: `--primary` -> `--context-ring-warn`.
 * 70–100%: `--context-ring-warn` -> `--destructive`. Explicit request: if
 * `--primary` changes in the future, the gradient's start changes on its
 * own, without touching this (see index.css for the `--context-ring-warn`
 * token's comment).
 */
export function contextUsageColor(pct: number): string {
  if (pct <= WARN_THRESHOLD) {
    const t = pct / WARN_THRESHOLD;
    return `color-mix(in oklch, var(--context-ring-warn) ${String(t * 100)}%, var(--primary))`;
  }
  const t = Math.min((pct - WARN_THRESHOLD) / (CRITICAL_THRESHOLD - WARN_THRESHOLD), 1);
  return `color-mix(in oklch, var(--destructive) ${String(t * 100)}%, var(--context-ring-warn))`;
}

/** Formats token counts compactly for the popover (e.g. 163_000 -> "163k",
 * 1_000_000 -> "1M"). Only used for display — the raw numbers come directly
 * from `ContextUsage`. */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${String(Math.round(n / 1000))}k`;
  }
  return String(Math.round(n));
}
