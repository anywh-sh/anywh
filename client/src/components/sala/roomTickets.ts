import { createContext, useContext } from "react";
import type { TicketTag } from "@/lib/integrations/model";

/** What a room's ticket chips need: whose cache to read, and a way to open a
 * ticket's screen (`null` where there is no pane for it). Provided by the
 * room panel; with no provider a chip is drawn inert. */
export interface RoomTickets {
  profileId: string;
  openTicket: ((ticket: TicketTag) => void) | null;
}

export const RoomTicketsContext = createContext<RoomTickets | null>(null);

export function useRoomTickets(): RoomTickets | null {
  return useContext(RoomTicketsContext);
}
