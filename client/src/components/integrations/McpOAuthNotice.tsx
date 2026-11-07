import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, X } from "lucide-react";
import { useDict } from "@/i18n";
import { dismissMcpOAuthNotice, getMcpOAuthNotice, subscribeMcpOAuthNotice } from "@/lib/integrations/oauthDeepLink";

/**
 * Says why a sign-in link the app was handed went nowhere (`oauthDeepLink.ts`).
 * Bottom-right and dismissed by hand, like `DownloadToasts` — and portaled to
 * `document.body` for the same reason (a `fixed` box inside a tab's
 * `contain`ed wrapper anchors to the wrapper, not the window).
 */
export function McpOAuthNotice() {
  const copy = useDict().integrations.oauthNotice;
  const notice = useSyncExternalStore(subscribeMcpOAuthNotice, getMcpOAuthNotice);
  if (!notice) return null;
  return createPortal(
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      <div
        role="status"
        className="pointer-events-auto flex max-w-96 min-w-87.5 items-center gap-2.5 border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-popover"
      >
        <CircleAlert className="size-4 shrink-0 text-muted-foreground" />
        <span>{copy[notice.kind]}</span>
        <button
          type="button"
          onClick={dismissMcpOAuthNotice}
          aria-label={copy.dismiss}
          className="ml-auto shrink-0 cursor-pointer p-0.5 text-text-faint transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
