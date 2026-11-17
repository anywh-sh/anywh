import type * as React from "react";
import { createPortal } from "react-dom";
import { CircleCheck, Info, OctagonX, TriangleAlert } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { Spinner } from "@/components/ui/spinner";

/**
 * The app's one toast region (shadcn's `sonner`, adapted): toasts pile up as
 * a stack in the corner — only the newest fully visible, the older ones
 * peeking out behind it — and fan out while the pointer is over the stack.
 *
 * Adapted from the shadcn scaffold in three ways:
 * - No `next-themes`: the colors come from this app's own theme tokens
 *   (`applyTheme` writes them on `:root`), so a theme switch reaches the
 *   toasts with no theme prop to keep in sync.
 * - The loading icon is the shared `Spinner`, not a spinning `Loader2`.
 * - Portaled to `document.body`: a toast region mounted inside a session
 *   tab's `contain: layout paint` wrapper would anchor its `fixed` corner to
 *   that wrapper instead of the viewport.
 *
 * Custom content (`toast.custom`) renders unstyled; it should fill the
 * toast's box (`h-full`, `overflow-hidden`) so a card stacked behind a
 * shorter front card is clipped to the front card's height instead of
 * spilling out under it.
 */
function Toaster(props: ToasterProps) {
  return createPortal(
    <Sonner
      className="toaster group"
      gap={8}
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Spinner size="lg" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />,
    document.body,
  );
}

export { Toaster };
