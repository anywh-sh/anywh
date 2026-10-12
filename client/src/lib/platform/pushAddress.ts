/**
 * Where this device's remote notifications are addressed. The open client has
 * no address of its own: a build that supports push installs a provider (the
 * contract is in docs/push.md), and everything here is inert until one does.
 * An address is opaque — the client hands it to relays and never looks inside.
 */

export interface PushAddress {
  /** What a relay posts to when something is worth a notification. */
  gatewayUrl: string;
  /** The capability that names this device to that gateway. */
  pushKey: string;
}

export interface PushAddressProvider {
  /** The current address, or `null` when there is none (signed out, no
   * permission). */
  getAddress(): Promise<PushAddress | null>;
  /** Called with the new address whenever it changes — rotated, issued after
   * a sign-in, gone after a sign-out. Returns the unsubscribe. */
  subscribe(listener: (address: PushAddress | null) => void): () => void;
}

let provider: PushAddressProvider | null = null;
const changeListeners = new Set<() => void>();

/** Installs (or, with `null`, removes) the provider. Listeners of
 * `onPushAddressProviderChange` hear about it. */
export function setPushAddressProvider(next: PushAddressProvider | null): void {
  provider = next;
  for (const listener of changeListeners) listener();
}

export function getPushAddressProvider(): PushAddressProvider | null {
  return provider;
}

/** For whoever follows the provider across installs (it can arrive after the
 * app has already started). */
export function onPushAddressProviderChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function isPushAddress(value: unknown): value is PushAddress {
  if (typeof value !== "object" || value === null) return false;
  const { gatewayUrl, pushKey } = value as Record<string, unknown>;
  return typeof gatewayUrl === "string" && gatewayUrl !== "" && typeof pushKey === "string" && pushKey !== "";
}
