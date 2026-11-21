import type { Dictionary } from "@/i18n";
import type { BotSummary } from "@/lib/bots/botTypes";

/** A bot's second line in the sidebar, and its tone: what needs the person
 * first, then what is going on, then what comes next. */
export function botStatusLine(bot: BotSummary, dict: Dictionary, formatTime: (at: number) => string): { text: string; tone: "attention" | "fail" | "normal" } {
  const status = dict.bots.status;
  if (bot.needsYou > 0) {
    const working = bot.working > 0 ? ` · ${status.working.replace("{count}", String(bot.working))}` : "";
    return { text: status.needsYou.replace("{count}", String(bot.needsYou)) + working, tone: "attention" };
  }
  if (bot.paused) return { text: status.paused, tone: "normal" };
  if (bot.firstRun) return { text: status.setup, tone: "normal" };
  if (bot.working > 0) return { text: status.working.replace("{count}", String(bot.working)), tone: "normal" };
  if (bot.busy) return { text: status.busy, tone: "normal" };
  if (bot.lastRunFailed) return { text: status.failed, tone: "fail" };
  if (bot.nextRun) return { text: status.next.replace("{name}", bot.nextRun.name).replace("{time}", formatTime(bot.nextRun.at)), tone: "normal" };
  if (bot.latestTask) return { text: `#${String(bot.latestTask.n)} ${bot.latestTask.title}`, tone: "normal" };
  return { text: status.idle, tone: "normal" };
}

/** Short day and time ("Mon 09:00"; "09:00" today). */
export function shortWhen(at: number, locale: string, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}
