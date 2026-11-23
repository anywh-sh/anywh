/** The host names a profile reaches a relay on this machine by, as a
 * profile stores them (an IPv6 literal without brackets). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether `host` is this machine's loopback, either as a profile stores it
 * or as a URL's `hostname` spells it (`[::1]`, bracketed). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host === "[::1]";
}
