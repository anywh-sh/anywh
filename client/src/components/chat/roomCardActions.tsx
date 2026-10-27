import { createContext, useContext } from "react";

/** What a room card can do. Provided by whoever hosts the chat (the room
 * panel swaps its right-hand panel; a plain tab opens the agent as a tab);
 * with no provider a card shows no button. */
export interface RoomCardActions {
  openAgent: (agentId: string) => void;
}

export const RoomCardActionsContext = createContext<RoomCardActions | null>(null);

export function useRoomCardActions(): RoomCardActions | null {
  return useContext(RoomCardActionsContext);
}
