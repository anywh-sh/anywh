import { setPushAddressProvider, type PushAddressProvider } from "@/lib/platform/pushAddress";

/**
 * What the app that embeds this client may install. The client is a web
 * bundle, so a native layer around it (a distribution with its own sign-in,
 * say) cannot call into its modules; it hands the client a function instead
 * and the client calls that function once, with this object, before the first
 * render (docs/push.md).
 */
export interface HostApi {
  /** Installs (or, with `null`, removes) the push address provider. */
  setPushAddressProvider(provider: PushAddressProvider | null): void;
}

declare global {
  interface Window {
    /** Set by the embedding app before the page runs, e.g. from a plugin's
     * initialization script. Absent in every build of the open client. */
    __anywhHostInit?: (api: HostApi) => void;
  }
}

const hostApi: HostApi = { setPushAddressProvider };

/** Offers `hostApi` to the embedding app, if there is one. A host that throws
 * must not take the client down with it. */
export function installHostBridge(): void {
  try {
    window.__anywhHostInit?.(hostApi);
  } catch (error) {
    console.error("host init failed", error);
  }
}
