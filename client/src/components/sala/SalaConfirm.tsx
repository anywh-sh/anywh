import { useRef } from "react";
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
}

interface SalaConfirmProps {
  /** The question, or `null` when none is open. */
  view: SalaConfirmView | null;
  /** The canvas: the question and its backdrop cover it, not the side panel. */
  container: HTMLElement | null;
  cancelLabel: string;
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
 * transform left its text soft.
 */
export function SalaConfirm({ view, container, cancelLabel, onCancel, onConfirm, onClosed }: SalaConfirmProps) {
  // The last question stays drawn while it animates out.
  const last = useRef<SalaConfirmView | null>(view);
  if (view) last.current = view;
  const shown = view ?? last.current;
  return (
    <Dialog.Root open={view !== null} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="sala-cfm-bd" data-float data-confirm onClick={onCancel} />
        <Dialog.Content
          className="sala-cfm"
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
                <Dialog.Cancel className="sala-cfm-c">{cancelLabel}</Dialog.Cancel>
                <Dialog.Action
                  className={cn("sala-cfm-ok", shown.danger && "danger")}
                  disabled={shown.pending}
                  onClick={(event) => {
                    event.preventDefault();
                    onConfirm();
                  }}
                >
                  {shown.ok}
                </Dialog.Action>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
