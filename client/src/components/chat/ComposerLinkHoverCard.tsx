import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createPortal } from "react-dom";
import { getMarkRange, type Editor, type Range } from "@tiptap/core";
import { Pencil } from "lucide-react";
import { EditLinkDialog } from "@/components/chat/EditLinkDialog";
import { useDict } from "@/i18n";

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 150;

interface ComposerLinkHoverCardProps {
  editor: Editor | null;
}

/** Hover card (href + edit) for the link created by paste-to-link in the
 * composer. A single instance per `Composer` (not per link) with native
 * listeners on `editor.view.dom` via event delegation — not a Tiptap
 * MarkView per link like before. MarkView (`ReactMarkViewRenderer`/
 * `addMarkView`) has a real, reproduced bug (not just a suspicion): any mark
 * it renders breaks ProseMirror's doc-position↔DOM mapping (`view.domAtPos`
 * falls back to the `<div contenteditable>` instead of descending to the
 * right text) as soon as it exists in the document — not just at its edge,
 * the whole paragraph. Reproduced in isolation (outside the app) with
 * Playwright: pasting a link left the cursor "stuck" at the pre-paste
 * position (bug 1 reported by the user), pasting over a selected text had
 * the same problem (bug 2), and deleting a selection that included a link
 * left no native selection at all, cursor "gone" (bug 3) — without MarkView
 * (mark rendered as a plain `<a>` via `renderHTML`, with no `contentDOM` of
 * its own) all three disappear, the same steps reproduced in isolation
 * correctly position the cursor again. The price is this file: hover/edit
 * can no longer live inside the link's own element (there's no longer a
 * React component per link), so hover detection and the edited link's
 * `range`/attributes are resolved from the native DOM element
 * (`closest("a.composer-link")` + `posAtDOM` + `getMarkRange`, the same
 * technique MarkView already used on hover). */
export function ComposerLinkHoverCard({ editor }: ComposerLinkHoverCardProps) {
  const dict = useDict();
  const [cardOpen, setCardOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentText, setCurrentText] = useState("");
  const [currentHref, setCurrentHref] = useState("");
  const rangeRef = useRef<Range | null>(null);
  const attrsRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimer(): void {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function scheduleClose(): void {
    clearTimer();
    timerRef.current = setTimeout(() => setCardOpen(false), CLOSE_DELAY_MS);
  }

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!editor) return;
    const currentEditor = editor;
    const dom = editor.view.dom;

    function linkElementFromEvent(event: Event): HTMLAnchorElement | null {
      const target = event.target;
      return target instanceof HTMLElement ? target.closest<HTMLAnchorElement>("a.composer-link") : null;
    }

    function handleMouseOver(event: MouseEvent): void {
      const link = linkElementFromEvent(event);
      if (!link) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        const linkType = currentEditor.schema.marks.link;
        const pos = currentEditor.view.posAtDOM(link, 0, 1);
        const $pos = currentEditor.state.doc.resolve(Math.min(pos + 1, currentEditor.state.doc.content.size));
        const range = linkType ? (getMarkRange($pos, linkType) ?? null) : null;
        rangeRef.current = range;
        // Read here, in the exact doc where `range` was resolved — never in
        // the render (the doc may have already changed and invalidated
        // `range` in the meantime, e.g. right after saving an edit,
        // `textBetween` with a pre-edit range blows up against the new doc).
        const linkMark = range ? currentEditor.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type === linkType) : undefined;
        attrsRef.current = linkMark?.attrs ?? { href: link.getAttribute("href") };
        setCurrentText(range ? currentEditor.state.doc.textBetween(range.from, range.to) : "");
        setCurrentHref(link.getAttribute("href") ?? "");
        setAnchorRect(link.getBoundingClientRect());
        setCardOpen(true);
      }, OPEN_DELAY_MS);
    }

    function handleMouseOut(event: MouseEvent): void {
      if (linkElementFromEvent(event)) scheduleClose();
    }

    // A real `<a href>` inside the contenteditable would navigate the page
    // on click — Tiptap's `Link` doesn't call `preventDefault` on its own
    // when `openOnClick: false` (it only avoids calling `window.open`).
    // Doesn't prevent normal cursor positioning: ProseMirror decides that
    // from `mousedown`, not `click`.
    function handleClick(event: MouseEvent): void {
      if (linkElementFromEvent(event)) event.preventDefault();
    }

    dom.addEventListener("mouseover", handleMouseOver);
    dom.addEventListener("mouseout", handleMouseOut);
    dom.addEventListener("click", handleClick);
    return () => {
      dom.removeEventListener("mouseover", handleMouseOver);
      dom.removeEventListener("mouseout", handleMouseOut);
      dom.removeEventListener("click", handleClick);
    };
  }, [editor]);

  function handleSave(text: string, newHref: string): void {
    const range = rangeRef.current;
    if (!range || !editor) return;
    editor
      .chain()
      .focus()
      .insertContentAt(range, {
        type: "text",
        text,
        marks: [{ type: "link", attrs: { ...attrsRef.current, href: newHref } }],
      })
      .run();
  }

  return (
    <>
      {cardOpen &&
        anchorRect &&
        createPortal(
          <div
            role="tooltip"
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            style={{ position: "fixed", left: anchorRect.left, top: anchorRect.top - 8, transform: "translateY(-100%)" }}
            className="z-50 flex w-auto max-w-72 items-center gap-1.5 border border-border bg-bg-elevated px-2.5 py-1.5 text-popover-foreground shadow-popover"
          >
            <span className="max-w-56 truncate font-mono text-xs text-muted-foreground">{currentHref}</span>
            <Button
              variant="chrome"
              size="icon-xs"
              onClick={() => {
                setCardOpen(false);
                setDialogOpen(true);
              }}
              aria-label={dict.chat.composer.openLinkEditor}
              className="size-5 hover:bg-border"
            >
              <Pencil className="size-3" />
            </Button>
          </div>,
          document.body,
        )}

      <EditLinkDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialText={currentText}
        initialHref={currentHref}
        onSave={(text, newHref) => {
          handleSave(text, newHref);
          setDialogOpen(false);
        }}
      />
    </>
  );
}
