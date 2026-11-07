import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { SessionLinkChips } from "./SessionLinkChips";
import type { WorkTicket } from "@/lib/integrations/model";

const worker = (agentTitle: string): WorkTicket => ({
  sessionId: "agent-1",
  ticket: { provider: "jira", site: "cloud-1", key: "NGL-9" },
  origin: "delegate",
  place: { roomId: "room-1", roomTitle: "", agentTitle, agentState: "working" },
  linkedAt: 1,
  lineDue: false,
});

describe("SessionLinkChips", () => {
  it("names a room agent the relay left untitled", () => {
    // The relay sends "" rather than an English fallback for an agent
    // with no title yet; the chip must still show a localized name.
    render(<SessionLinkChips profileId="p1" links={[worker("")]} />);
    expect(screen.getByText(en.sala.card.untitled)).toBeInTheDocument();
  });

  it("names a room agent by its own title", () => {
    render(<SessionLinkChips profileId="p1" links={[worker("Stop the spinner")]} />);
    expect(screen.getByText("Stop the spinner")).toBeInTheDocument();
  });
});
