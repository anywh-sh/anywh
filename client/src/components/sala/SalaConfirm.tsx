import { useLayoutEffect, useRef } from "react";
import { AlertDialog as Dialog } from "radix-ui";
import { cn } from "@/lib/utils";

/** What the question says: a title, a sentence, optional tags (the areas
 * agents would leave, the branches whose work would be lost) and the answer
 * that goes ahead. */
export interface SalaConfirmView {
  title: string;
  body: string;
  tags: readonly { key: string; label: string }[];
  ok: string;
  danger: boolean;
  /** The answer cannot be given yet (the room is still checking). */
  pending: boolean;
  /** What the check found, said in the footer's free space beside the
   * buttons (`warn`: work that the answer discards). */
  note: { text: string; warn: boolean } | null;
}

interface SalaConfirmProps {
  /** The question, or `null` when none is open. */
  view: SalaConfirmView | null;
  /** The canvas: the question and its backdrop cover it, not the side panel. */
  container: HTMLElement | null;
  cancelLabel: string;
  /** The answer button's name while it waits (`pending`). */
  pendingLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** Focus goes back to the canvas once the question is gone. */
  onClosed: () => void;
}

/**
 * The question the room asks before an action that cannot simply be taken
 * back, drawn as the design's card over the canvas. Radix's alert dialog
 * keeps focus inside and answers Esc; Enter answers yes.
 *
 * It sits inside the canvas, in the canvas's own unscaled layer, and is
 * placed by layout alone (auto margins, no `translate(-50%)`): a fractional
 * transform left its text soft. It comes in and goes out with one-shot
 * fades (`sala.css`) that leave nothing composited once they end.
 */
export function SalaConfirm({ view, container, cancelLabel, pendingLabel, onCancel, onConfirm, onClosed }: SalaConfirmProps) {
  // The last question stays drawn while it animates out.
  const last = useRef<SalaConfirmView | null>(view);
  if (view) last.current = view;
  const shown = view ?? last.current;
  // Auto margins centre the card on a half pixel whenever the room it
  // centres in is odd: it is nudged onto the device's pixel grid, through
  // `top` (half of which moves an auto-centred box), never a transform.
  // Measured at rest: again once the entrance (which moves `top`) ends.
  const card = useRef<HTMLDivElement>(null);
  const open = view !== null;
  const snap = (): void => {
    const el = card.current;
    if (!el || !open || el.getAnimations?.().some((a) => a.playState === "running")) return;
    el.style.top = "";
    const ratio = window.devicePixelRatio || 1;
    const y = el.getBoundingClientRect().top;
    const off = y - Math.round(y * ratio) / ratio;
    if (Math.abs(off) > 0.01) el.style.top = `${(-2 * off).toFixed(3)}px`;
  };
  useLayoutEffect(snap, [open, view?.title, view?.body]);
  return (
    <Dialog.Root open={view !== null} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="sala-cfm-bd" data-float data-confirm onClick={onCancel} />
        <Dialog.Content
          ref={card}
          className="sala-cfm"
          onAnimationEnd={snap}
          data-float
          data-confirm
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onConfirm();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onClosed();
          }}
        >
          {shown && (
            <>
              <div className="sala-cfm-b">
                <Dialog.Title className="sala-cfm-t">{shown.title}</Dialog.Title>
                <Dialog.Description className="sala-cfm-d">{shown.body}</Dialog.Description>
                {shown.tags.length > 0 && (
                  <div className="sala-cfm-l">
                    {shown.tags.map((tag) => (
                      <span key={tag.key}>{tag.label}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="sala-cfm-a">
                {/* Always there, empty or not, and as tall as the buttons:
                    what the check finds changes no size in the card. */}
                <span className={cn("sala-cfm-note", shown.note?.warn && "warn")} role="status" title={shown.note?.text}>
                  <span>{shown.note?.text}</span>
                </span>
                <Dialog.Cancel className="sala-cfm-c">{cancelLabel}</Dialog.Cancel>
                <Dialog.Action
                  className={cn("sala-cfm-ok", shown.danger && "danger")}
                  disabled={shown.pending}
                  aria-busy={shown.pending}
                  aria-label={shown.pending ? pendingLabel : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onConfirm();
                  }}
                >
                  {/* The label keeps its place while a spinner stands in for
                      it, so the button does not change size. */}
                  <span className="sala-cfm-ok-label">{shown.ok}</span>
                  {shown.pending && <span className="sala-spin" aria-hidden="true" />}
                </Dialog.Action>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
