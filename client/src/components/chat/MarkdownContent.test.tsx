import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownContent } from "./MarkdownContent";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

describe("MarkdownContent", () => {
  it("renders a path-like inline code span as a clickable button when onOpenPath is given", async () => {
    const onOpenPath = vi.fn();
    render(<MarkdownContent text="Salvei em `screenshots/PROJ-929/foo.png`." onOpenPath={onOpenPath} />);

    const link = screen.getByRole("button", { name: "screenshots/PROJ-929/foo.png" });
    await userEvent.click(link);
    expect(onOpenPath).toHaveBeenCalledWith("screenshots/PROJ-929/foo.png");
  });

  it("leaves a path-like inline code span as plain code when onOpenPath is omitted", () => {
    render(<MarkdownContent text="Salvei em `screenshots/PROJ-929/foo.png`." />);

    expect(screen.queryByRole("button", { name: "screenshots/PROJ-929/foo.png" })).not.toBeInTheDocument();
    expect(screen.getByText("screenshots/PROJ-929/foo.png").tagName).toBe("CODE");
  });

  it("leaves inline code that doesn't look like a path as plain code", () => {
    const onOpenPath = vi.fn();
    render(<MarkdownContent text="Roda com `npm test`." onOpenPath={onOpenPath} />);

    expect(screen.queryByRole("button", { name: "npm test" })).not.toBeInTheDocument();
    expect(screen.getByText("npm test").tagName).toBe("CODE");
  });

  it("doesn't linkify a path-like string inside a fenced code block, even with onOpenPath given", () => {
    const onOpenPath = vi.fn();
    render(<MarkdownContent text={"```\nscreenshots/PROJ-929/foo.png\n```"} onOpenPath={onOpenPath} />);

    expect(screen.queryByRole("button", { name: /foo\.png/ })).not.toBeInTheDocument();
  });

  it("opens a real http(s) markdown link via the platform opener", async () => {
    render(<MarkdownContent text="Veja [aqui](https://example.com)." />);

    await userEvent.click(screen.getByRole("link", { name: "aqui" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("routes a markdown link whose href is a relative path to onOpenPath instead of the opener", async () => {
    const onOpenPath = vi.fn();
    render(<MarkdownContent text="Veja [o relatório](screenshots/PROJ-929/foo.png)." onOpenPath={onOpenPath} />);

    const link = screen.getByRole("button", { name: "o relatório" });
    await userEvent.click(link);
    expect(onOpenPath).toHaveBeenCalledWith("screenshots/PROJ-929/foo.png");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders a path-href markdown link as plain text when onOpenPath is omitted, instead of a dead link", () => {
    render(<MarkdownContent text="Veja [o relatório](screenshots/PROJ-929/foo.png)." />);

    expect(screen.queryByRole("link", { name: "o relatório" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "o relatório" })).not.toBeInTheDocument();
    expect(screen.getByText("o relatório").tagName).toBe("SPAN");
  });

  it("opens a backtick-wrapped URL through the platform opener instead of leaving it as inert code", async () => {
    render(<MarkdownContent text="Confira `https://example.com` pra detalhes." />);

    const link = screen.getByRole("link", { name: "https://example.com" });
    await userEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("renders a table inside a scroll wrapper so one long cell scrolls instead of clipping columns", () => {
    const { container } = render(<MarkdownContent text={"| # | File |\n|---|---|\n| 1 | /a/very/long/path.tsx |"} />);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.parentElement).toHaveClass("prose-chat-table");
  });

  it("keeps a short table cell on one line and lets a long one wrap", () => {
    const text = "| Dia | What happens |\n|---|---|\n| 14 + até 30 | Stripe only releases the money after 30 days for a Brazilian card and 5 days for an international one |";
    const { container } = render(<MarkdownContent text={text} />);

    const [short, long] = Array.from(container.querySelectorAll("tbody td"));
    expect(short).toHaveClass("whitespace-nowrap");
    expect(long).not.toHaveClass("whitespace-nowrap");
    expect(container.querySelector("th")).toHaveClass("whitespace-nowrap");
  });
});
