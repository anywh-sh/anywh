/**
 * Whether `host` reads as a host name, an IPv4 address or a bracketed (or
 * bare) IPv6 one. Deliberately narrow: what is typed here ends up in a
 * shell command the reader copies (`--relay-host <host>`) and in a URL, and
 * nothing a real address needs — letters, digits, dots, hyphens, colons,
 * brackets — can turn either into something else.
 */
export function isValidHost(host: string): boolean {
  return /^[A-Za-z0-9.\-:[\]]+$/.test(host);
}
