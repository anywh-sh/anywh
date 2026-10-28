import { memo, useEffect, useReducer } from "react";
import "@/components/chat/roomCard.css";
import { useRoomCardActions } from "@/components/chat/roomCardActions";
import { CheckIcon, CloseIcon, QuestionIcon } from "@/components/sala/SalaIcons";
import { formatCompactTime } from "@/lib/format/relativeTime";
import type { RoomCard as RoomCardData, RoomReportCard } from "@/lib/relay/agent-event";
import { useDict, useLocale } from "@/i18n";

/** Re-renders every minute so "5m" keeps counting; isolated to the label. */
function useMinuteTick(): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const interval = window.setInterval(tick, 60_000);
    return () => window.clearInterval(interval);
  }, []);
}

function ReportCard({ report }: { report: RoomReportCard }) {
  const dict = useDict();
  const copy = dict.chat.log.roomCard;
  const { locale } = useLocale();
  const actions = useRoomCardActions();
  useMinuteTick();

  // An agent that has already reported is not "starting".
  const title = report.title ?? copy.untitledAgent;
  const status = report.status === "done" ? copy.done : report.status === "failed" ? copy.failed : copy.needsYou;
  const blocked = report.status === "blocked";
  const compact = formatCompactTime(report.at, locale);
  // "ago" only fits a span: not the word "now" (under a minute), nor the date a week or more gives.
  const age = Date.now() - report.at;
  const time = Number.isFinite(report.at) && age >= 45_000 && age < 7 * 86_400_000 ? copy.ago.replace("{time}", compact) : compact;
  const Icon = report.status === "done" ? CheckIcon : blocked ? QuestionIcon : CloseIcon;

  return (
    <div className="room-card" data-status={report.status} data-agent-id={report.agentId}>
      <span className="room-card-icon" aria-hidden="true">
        <Icon size={report.status === "failed" ? 12 : 14} />
      </span>
      <div className="room-card-body">
        <span className="room-card-label">{copy.label.replace("{status}", status).replace("{time}", time)}</span>
        <span className="room-card-title" title={title}>
          {title}
        </span>
      </div>
      {actions && (
        <button
          type="button"
          className={blocked ? "room-card-btn cta" : "room-card-btn"}
          aria-label={(blocked ? copy.replyAria : copy.openAria).replace("{title}", title)}
          onClick={() => actions.openAgent(report.agentId)}
        >
          {blocked ? copy.reply : copy.open}
        </button>
      )}
    </div>
  );
}

/** What a room turn shows instead of a chat bubble: one card per report an
 * agent's workers handed back, or the title of a task handed down to it. */
export const RoomCard = memo(function RoomCard({ room }: { room: RoomCardData }) {
  const dict = useDict();

  if (room.kind === "reports") {
    return (
      <div className="flex flex-col gap-2">
        {room.reports.map((report) => (
          <ReportCard key={`${report.agentId}:${String(report.at)}`} report={report} />
        ))}
      </div>
    );
  }

  const title = room.title ?? dict.sala.card.untitled;
  return (
    <div className="flex justify-end">
      <div className="room-card max-w-[86%]" role="group" aria-label={dict.chat.log.roomCard.instructionAria.replace("{title}", title)}>
        <span className="room-card-title" title={title}>
          {title}
        </span>
      </div>
    </div>
  );
});
