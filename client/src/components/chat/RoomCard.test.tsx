import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoomCard } from "./RoomCard";
import { RoomCardActionsContext } from "./roomCardActions";
import { LocaleProvider, LOCALE_STORAGE_KEY } from "@/i18n";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import type { RoomCard as RoomCardData } from "@/lib/relay/agent-event";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const reports: RoomCardData = {
  kind: "reports",
  reports: [
    { agentId: "a1", title: "Ship the login", status: "done", at: Date.now() },
    { agentId: "a2", title: "Fix the build", status: "failed", at: Date.now() },
    { agentId: "a3", title: null, status: "blocked", at: Date.now() },
  ],
};

function renderCard(room: RoomCardData, openAgent?: (id: string) => void) {
  return render(
    <LocaleProvider>
      {openAgent ? (
        <RoomCardActionsContext.Provider value={{ openAgent }}>
          <RoomCard room={room} />
        </RoomCardActionsContext.Provider>
      ) : (
        <RoomCard room={room} />
      )}
    </LocaleProvider>,
  );
}

describe("RoomCard", () => {
  it("shows one card per report with its status, title and the right button", async () => {
    const openAgent = vi.fn();
    renderCard(reports, openAgent);

    expect(screen.getByText(/^Ready · /)).toBeInTheDocument();
    expect(screen.getByText(/^Failed · /)).toBeInTheDocument();
    expect(screen.getByText(/^Needs you · /)).toBeInTheDocument();
    expect(screen.getByText("Ship the login")).toBeInTheDocument();
    expect(screen.getByText(en.chat.log.roomCard.untitledAgent)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Reply to " + en.chat.log.roomCard.untitledAgent }));
    expect(openAgent).toHaveBeenCalledWith("a3");
    await userEvent.click(screen.getByRole("button", { name: "Open Ship the login" }));
    expect(openAgent).toHaveBeenCalledWith("a1");
  });

  it("shows no button without an actions provider", () => {
    renderCard(reports);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("speaks pt-BR", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "pt-BR");
    renderCard(reports, vi.fn());
    expect(screen.getByText(/^Pronto · /)).toBeInTheDocument();
    expect(screen.getByText(/^Precisa de você · /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Responder a " + ptBr.chat.log.roomCard.untitledAgent })).toBeInTheDocument();
  });

  it("says how long ago a report came in, in the language of the app", () => {
    const at = Date.now() - 12 * 60_000;
    const old: RoomCardData = { kind: "reports", reports: [{ agentId: "a1", title: "Old", status: "done", at }] };
    renderCard(old);
    expect(screen.getByText(/^Ready · 12m ago$/)).toBeInTheDocument();
    cleanup();
    localStorage.setItem(LOCALE_STORAGE_KEY, "pt-BR");
    renderCard(old);
    expect(screen.getByText(/^Pronto · há 12 ?min$/)).toBeInTheDocument();
  });

  it("gives a date, not 'ago', after a week", () => {
    const week: RoomCardData = { kind: "reports", reports: [{ agentId: "a1", title: "Old", status: "done", at: Date.now() - 20 * 86_400_000 }] };
    renderCard(week);
    expect(screen.getByText(/^Ready · /).textContent).not.toMatch(/ago/);
  });

  it("draws an instruction as its title alone, with no button", () => {
    renderCard({ kind: "instruction", title: "Write the docs" }, vi.fn());
    expect(screen.getByRole("group", { name: "Task from the orchestrator: Write the docs" })).toHaveTextContent("Write the docs");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("falls back to the starting title when the instruction has none", () => {
    renderCard({ kind: "instruction", title: null });
    expect(screen.getByText(en.sala.card.untitled)).toBeInTheDocument();
  });
});
