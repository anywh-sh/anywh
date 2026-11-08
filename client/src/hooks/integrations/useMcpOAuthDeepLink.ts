import { useEffect } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { inTauri } from "@/lib/platform/tauri";
import { routeMcpOAuthCallback } from "@/lib/integrations/oauthDeepLink";

/**
 * Listens for `anywh://mcp-oauth/callback…` links — where the browser ends an
 * MCP server's sign-in — and hands each to `oauthDeepLink.ts`, which forwards
 * it to the relay waiting for it. A second listener beside
 * `useProfileImport`'s, on the same two delivery paths (`getCurrent()` for a
 * cold launch, `onOpenUrl` while running); each takes only its own host.
 *
 * `getCurrent()` is deferred a tick for the same StrictMode reason as
 * `useProfileImport`; a link reported twice is deduped by the router.
 */
export function useMcpOAuthDeepLink(): void {
  useEffect(() => {
    if (!inTauri()) return;

    function handle(urls: string[]): void {
      for (const url of urls) routeMcpOAuthCallback(url);
    }

    const initialUrlTimer = setTimeout(() => {
      void getCurrent().then((urls) => {
        if (urls) handle(urls);
      });
    }, 0);
    const unlistenPromise = onOpenUrl(handle);

    return () => {
      clearTimeout(initialUrlTimer);
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
