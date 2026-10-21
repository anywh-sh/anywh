import { memo } from "react";
import { useRoomChannel } from "@/hooks/sala/useRoomChannel";
import { findProfile } from "@/lib/profiles/profiles";
import type { MergedSession } from "@/lib/format/sessionGrouping";

function Probe({ profileId, roomId }: { profileId: string; roomId: string }) {
  const profile = findProfile(profileId);
  // Never rendered without a profile (the parent filters), but a profile can
  // be removed between two renders.
  if (!profile) return null;
  return <ProbeChannel profile={profile} roomId={roomId} />;
}

function ProbeChannel({ profile, roomId }: { profile: NonNullable<ReturnType<typeof findProfile>>; roomId: string }) {
  useRoomChannel(profile, roomId);
  return null;
}

/**
 * Keeps one room channel open per room the sidebar lists, so a room row, its
 * tab and the status bar show how the room is doing even while its canvas is
 * not on screen. Renders nothing.
 */
export const RoomStatusProbes = memo(function RoomStatusProbes({ sessions }: { sessions: readonly MergedSession[] }) {
  return (
    <>
      {sessions
        .filter((session) => session.room === true)
        .map((session) => (
          <Probe key={`${session.profileId}:${session.id}`} profileId={session.profileId} roomId={session.id} />
        ))}
    </>
  );
});
