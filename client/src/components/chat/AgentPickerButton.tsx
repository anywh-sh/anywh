import { useEffect, useState } from "react";
import { getHostInfo, type SelectableAgentInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";

interface AgentPickerButtonProps {
  profile: Profile;
}

/**
 * Renders nothing today. `/host-info`'s `agents` only ever lists ids that
 * have an actual engine behind them (relay's `SELECTABLE_AGENT_IDS`) — just
 * Claude for now — so there is never more than one entry to choose between.
 * The fetch below still runs for real (same `getHostInfo(profile)` effect
 * `FileTree.tsx` uses, not a new shared hook for a value with one
 * consumer): the day a second engine exists, rendering a dropdown here is
 * the only change needed, instead of wiring fetch + prop-threading through
 * Composer/ChatPanel from scratch.
 */
export function AgentPickerButton({ profile }: AgentPickerButtonProps) {
  const [agents, setAgents] = useState<SelectableAgentInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (!cancelled) setAgents(info.agents ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile]);

  if (agents.length <= 1) return null;

  // Unreachable until a second selectable agent exists.
  return null;
}
