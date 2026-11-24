import { BotRequestError } from "@/lib/bots/botClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { BOT_TEMPLATE_KINDS, type BotCreateFailure, type EventProps } from "@/lib/telemetry/events";

/**
 * What the bots' state reduces to before it leaves: counts and closed
 * lists. A bot's name, its soul, its tasks and what it says never do.
 */

/** A template id this build ships, `blank` for none, `other` for one it
 * does not know (a template id is any string on the relay). */
export function templateKind(templateId: string | undefined): (typeof BOT_TEMPLATE_KINDS)[number] {
  if (templateId === undefined) return "blank";
  return (BOT_TEMPLATE_KINDS as readonly string[]).includes(templateId) && templateId !== "blank" && templateId !== "other"
    ? (templateId as (typeof BOT_TEMPLATE_KINDS)[number])
    : "other";
}

/** Why creating a bot failed, from what the relay answered: 503 is its
 * agent host being down, a 4xx the input refused, no answer the network. */
export function createFailureOf(error: unknown): BotCreateFailure {
  if (error instanceof BotRequestError) {
    if (error.status === 503) return "no_host";
    if (error.status >= 400 && error.status < 500) return "invalid";
    return "other";
  }
  return error instanceof TypeError ? "network" : "other";
}

/** One profile's bots as a day's snapshot. */
export function botsSnapshot(bots: readonly BotSummary[]): EventProps<"bots_snapshot"> {
  // Capped at what the registry accepts: an out-of-range count would drop
  // the whole snapshot.
  const counting = (test: (bot: BotSummary) => boolean): number => Math.min(100, bots.filter(test).length);
  const snapshot: EventProps<"bots_snapshot"> = {
    bot_count: Math.min(100, bots.length),
    from_template: counting((bot) => bot.templateId !== undefined),
    paused: counting((bot) => bot.paused),
    first_run: counting((bot) => bot.firstRun),
    scheduled: counting((bot) => bot.nextRun !== undefined),
    last_run_failed: counting((bot) => bot.lastRunFailed),
    limited: counting((bot) => bot.limitedUntil !== undefined),
    needs_you: Math.min(1000, bots.reduce((sum, bot) => sum + bot.needsYou, 0)),
  };
  // A relay that sends these sends them for every bot; an older one, for none.
  if (bots.length > 0 && bots.every((bot) => bot.scheduleCount !== undefined && bot.runs24h !== undefined && bot.peer24h !== undefined)) {
    const sum = (pick: (bot: BotSummary) => number): number => Math.min(5000, bots.reduce((total, bot) => total + pick(bot), 0));
    snapshot.schedules = Math.min(2000, sum((bot) => bot.scheduleCount ?? 0));
    snapshot.runs_24h_replied = sum((bot) => bot.runs24h?.replied ?? 0);
    snapshot.runs_24h_silent = sum((bot) => bot.runs24h?.silent ?? 0);
    snapshot.runs_24h_failed = sum((bot) => bot.runs24h?.failed ?? 0);
    snapshot.runs_24h_missed = sum((bot) => bot.runs24h?.missed ?? 0);
    snapshot.runs_24h_limited = sum((bot) => bot.runs24h?.limited ?? 0);
    snapshot.peer_asks_24h = sum((bot) => bot.peer24h?.asks ?? 0);
    snapshot.peer_handoffs_24h = sum((bot) => bot.peer24h?.handoffs ?? 0);
  }
  return snapshot;
}
