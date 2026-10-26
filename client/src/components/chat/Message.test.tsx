import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserBubble } from "./Message";
import { en } from "@/i18n/en";
import { OpenState, OpenStateContext } from "@/lib/format/openState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
      expect(paragraphs[0].innerHTML).toBe("first<br>second");
      expect(paragraphs[1].textContent).toBe("third");
    });

    it("keeps a pasted trace's indentation and runs of spaces", () => {
      renderBubble({ text: "Traceback:\n  File \"a.py\", line 3\n    x  =  1\n> quoted\n>   deeper\n\nhard  \nbreak" });

      const [trace, quote, hard] = document.querySelectorAll(".prose-chat p");
      expect(trace.textContent).toBe('Traceback:  File "a.py", line 3    x  =  1');
      expect(trace.querySelectorAll("br")).toHaveLength(2);
      // No newline text is left next to a break for `pre-wrap` to double.
      expect(trace.innerHTML).not.toContain("\n");
      // A blockquote's continuation carries its `>` in the source; the
      // parsed text is kept there rather than leaking the marker back in.
      expect(quote.textContent).toBe("quoteddeeper");
      // A markdown hard break (two trailing spaces) is a single `<br>` too.
      expect(hard.innerHTML).toBe("hard<br>break");
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

    it("leaves a Python dunder as typed rather than bold", () => {
      renderBubble({ text: 'File "a.py", line 3, in __init__\n\n**bold** and __also bold__' });

      expect(screen.getByText('File "a.py", line 3, in __init__')).toBeInTheDocument();
      expect(screen.getByText("bold").tagName).toBe("STRONG");
      expect(screen.getByText("also bold").tagName).toBe("STRONG");
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

  describe("clips a long message", () => {
    function renderInLog(openState: OpenState) {
      return render(
        <OpenStateContext.Provider value={openState}>
          <TooltipProvider>
            <UserBubble
              id="m1"
              text="a long message"
              sentAt={Date.now()}
              isEditing={false}
              onStartEdit={vi.fn()}
              onCancelEdit={vi.fn()}
              onSaveEdit={vi.fn()}
              onCopy={vi.fn()}
            />
          </TooltipProvider>
        </OpenStateContext.Provider>,
      );
    }

    it("offers no toggle for a message that fits", () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(330);
      renderInLog(new OpenState());

      expect(screen.queryByRole("button", { name: en.chat.message.showAll })).not.toBeInTheDocument();
    });

    it("expands and folds a tall one, and remembers it across the row remounting", async () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
      const user = userEvent.setup();
      const openState = new OpenState();
      const { unmount } = renderInLog(openState);

      const expand = screen.getByRole("button", { name: en.chat.message.showAll });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      expect(document.getElementById(expand.getAttribute("aria-controls")!)).toHaveStyle({ maxHeight: "320px" });

      await user.click(expand);
      const collapse = screen.getByRole("button", { name: en.chat.message.showLess });
      expect(collapse).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(collapse.getAttribute("aria-controls")!)?.style.maxHeight).toBe("");

      // The virtualized log unmounts a row scrolled out of view.
      unmount();
      renderInLog(openState);
      expect(screen.getByRole("button", { name: en.chat.message.showLess })).toBeInTheDocument();
    });
  });
});
