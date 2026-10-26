import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserBubble } from "./Message";
import { en } from "@/i18n/en";

afterEach(() => cleanup());

/**
 * The action strip under a sent message had no test of any kind, and it is
 * where the redesign moved four Portuguese literals into the dictionary. The
 * labels are the whole interface of these buttons — they carry no text —
 * so a label that silently stops matching is a control nobody can name.
 */
function renderBubble(props: Partial<Parameters<typeof UserBubble>[0]> = {}) {
  const onStartEdit = vi.fn();
  const onCopy = vi.fn();
  render(
    <TooltipProvider>
      <UserBubble
        id="m1"
        text="uma mensagem"
        sentAt={Date.now()}
        isEditing={false}
        onStartEdit={onStartEdit}
        onCancelEdit={vi.fn()}
        onSaveEdit={vi.fn()}
        onCopy={onCopy}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onStartEdit, onCopy };
}

describe("UserBubble", () => {
  it("names its actions from the dictionary", () => {
    renderBubble();

    expect(screen.getByRole("button", { name: en.chat.message.copy })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.chat.message.edit })).toBeInTheDocument();
  });

  it("starts an edit with the message's own text", async () => {
    const user = userEvent.setup();
    const { onStartEdit } = renderBubble();

    await user.click(screen.getByRole("button", { name: en.chat.message.edit }));

    expect(onStartEdit).toHaveBeenCalledWith("m1", "uma mensagem");
  });

  it("switches the copy button's label to the confirmation after copying", async () => {
    const user = userEvent.setup();
    const { onCopy } = renderBubble();

    await user.click(screen.getByRole("button", { name: en.chat.message.copy }));

    expect(onCopy).toHaveBeenCalledWith("uma mensagem");
    expect(screen.getByRole("button", { name: en.chat.message.copied })).toBeInTheDocument();
  });

  // Truncating history at a message that carried an image would have to
  // resend the attachment, which the edit path doesn't do — so the button is
  // disabled rather than quietly dropping the image. The tooltip is the only
  // place that says why, and a disabled button gets no pointer events, hence
  // the `span` wrapper it is written with.
  it("explains why editing is unavailable on a message with an attachment", async () => {
    const user = userEvent.setup();
    renderBubble({ images: [{ path: "/tmp/a.png", kind: "image", previewUrl: "blob:a" }] });

    const disabled = screen.getByRole("button", { name: en.chat.message.editUnavailable });
    expect(disabled).toBeDisabled();

    await user.hover(disabled.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(en.chat.message.editWithAttachment);
  });

  describe("renders its text as markdown", () => {
    it("formats emphasis, lists, inline code and links", () => {
      renderBubble({ text: "**bold** and `code`\n\n- one\n- two\n\n[docs](https://example.com)" });

      expect(screen.getByText("bold").tagName).toBe("STRONG");
      expect(screen.getByText("code").tagName).toBe("CODE");
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com");
    });

    it("keeps a single newline as a line break and a blank line as a new paragraph", () => {
      renderBubble({ text: "first\nsecond\n\nthird" });

      const paragraphs = document.querySelectorAll(".prose-chat p");
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0].querySelectorAll("br")).toHaveLength(1);
      expect(paragraphs[0].textContent?.replace(/\s+/g, " ")).toBe("first second");
      expect(paragraphs[1].textContent).toBe("third");
    });

    // A pasted log is full of lines that are markdown headings or rules by
    // accident — `# comment`, a line underlined with `===`.
    it("leaves headings and rules as the literal text typed", () => {
      renderBubble({ text: "# not a title\n\nResult\n======\n\n---" });

      expect(screen.queryByRole("heading")).not.toBeInTheDocument();
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
      expect(screen.getByText("# not a title")).toBeInTheDocument();
      expect(screen.getByText("======", { exact: false })).toBeInTheDocument();
      expect(screen.getByText("---")).toBeInTheDocument();
    });

    it("shows raw HTML as text instead of markup", () => {
      renderBubble({ text: "<b>x</b> inline\n\n<script>alert(1)</script>" });

      expect(document.querySelector(".prose-chat b")).toBeNull();
      expect(document.querySelector(".prose-chat script")).toBeNull();
      expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
      expect(screen.getByText("<b>", { exact: false })).toBeInTheDocument();
    });

    it("drops a javascript: href", () => {
      renderBubble({ text: "[click](javascript:alert(1))" });

      expect(screen.getByText("click").closest("a")?.getAttribute("href") ?? "").not.toContain("javascript");
    });
  });
});
