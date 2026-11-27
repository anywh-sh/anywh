import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useDict } from "@/i18n"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-overlay",
        className
      )}
      {...props}
    />
  )
}

/**
 * A dialog is a framed panel, not a padded box: the header is a band in the
 * chrome surface with a divider under it, and everything below it is laid
 * out by `DialogBody`/`DialogFooter`. Hence no padding here — a consumer
 * that needs an edge-to-edge region (the settings dialog's two panes) just
 * doesn't use `DialogBody`.
 *
 * Two sizes:
 *
 * - `default` fits its content, up to a form's width (callers narrow or
 *   widen it with a `sm:max-w-*`), and opens and closes at once.
 * - `large` is a fixed frame over almost the whole window, a margin all
 *   round, for content that wants the room rather than a size of its own (a
 *   picture, a video). It clears the native top bar on iOS, which covers
 *   the top of the webview there (`--native-top-inset`, unset elsewhere),
 *   and the home indicator. A frame that big appearing at once is a jolt,
 *   so it grows into place and fades out (`data-size="large"` in
 *   index.css). The growing waits for the frame to be painted once
 *   (`markEnteredAfterFirstPaint`).
 */
const dialogContentVariants = cva(
  "fixed z-50 flex flex-col overflow-hidden border border-border bg-bg-sidebar shadow-popover outline-none",
  {
    variants: {
      size: {
        default: "inset-0 m-auto h-fit max-h-[calc(100%-3rem)] w-full max-w-[calc(100%-2rem)] sm:max-w-lg",
        large:
          "inset-x-2 top-[calc(var(--native-top-inset,0px)+0.5rem)] bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:inset-x-12 sm:top-[calc(var(--native-top-inset,0px)+3rem)] sm:bottom-[calc(env(safe-area-inset-bottom)+3rem)]",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

/**
 * Sets `data-entered` on a large dialog two frames after it mounts, once its
 * first frame is painted, and only then does its entrance play (index.css).
 * Mounting it (the focus trap, the scroll lock, a picture inside) is what
 * that first frame pays for, and WebKit times an animation from the moment
 * its style is resolved, not from the frame that shows it: started on mount,
 * the frame was already most of the way in by the time it appeared, and
 * opening looked instant on macOS and iOS while closing visibly faded. Until
 * then the frame and its backdrop stay transparent.
 */
function markEnteredAfterFirstPaint(node: HTMLElement): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => node.setAttribute("data-entered", ""))
  })
  return () => cancelAnimationFrame(frame)
}

function DialogContent({
  className,
  size = "default",
  ref,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof dialogContentVariants>) {
  // Stable for a given ref, so a re-render doesn't restart the wait.
  const contentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
      if (!node) return
      const cancel = size === "large" ? markEnteredAfterFirstPaint(node) : undefined
      return () => {
        cancel?.()
        if (typeof ref === "function") ref(null)
        else if (ref) ref.current = null
      }
    },
    [ref, size]
  )

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        data-size={size}
        className={cn(dialogContentVariants({ size, className }))}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/**
 * The header band: title on the left, close button squared off on the
 * right. `children` is normally just a `DialogTitle` — a description
 * belongs in the body, where it can wrap without pushing the band around.
 * `actions` are controls about what the dialog shows (the media viewer's
 * zoom, copy and download), laid out just before the close button.
 */
function DialogHeader({
  className,
  children,
  actions,
  showCloseButton = true,
  ...props
}: React.ComponentProps<"div"> & { actions?: React.ReactNode; showCloseButton?: boolean }) {
  const dict = useDict()

  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-none items-center gap-3 border-b border-border bg-bg-chrome py-3 pr-3 pl-4",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon-sm" aria-label={dict.common.close}>
            <XIcon className="size-3.5" />
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

/** The padded region under the band. Scrolls on its own so a long dialog
 * keeps its header and footer in place. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-none flex-col-reverse gap-2 px-4 pb-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("truncate font-display text-[19px] leading-none font-bold tracking-[-0.025em]", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  dialogContentVariants,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
