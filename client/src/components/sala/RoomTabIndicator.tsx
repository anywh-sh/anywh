import { Spinner } from "@/components/ui/spinner";
import { useDict } from "@/i18n";
import { useRoomStatus } from "@/lib/sala/roomStatus";

/** The state dot of a room's tab: orange when something waits for the
 * person, a spinner while its agents work, a red square after a failure. */
export function RoomTabIndicator({ roomId }: { roomId: string }) {
  const sidebar = useDict().shell.sidebar;
  const status = useRoomStatus(roomId);
  if (!status) return null;
  if (status.needsYou > 0) return <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={sidebar.roomNeedsYou.replace("{count}", String(status.needsYou))} />;
  if (status.working > 0) return <Spinner size="sm" role="img" label={sidebar.roomWorking.replace("{count}", String(status.working))} />;
  if (status.failed > 0) return <span className="size-1.5 shrink-0 bg-destructive" aria-label={sidebar.roomFailed.replace("{count}", String(status.failed))} />;
  return null;
}
