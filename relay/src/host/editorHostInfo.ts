import { networkInterfaces } from "node:os";

// Backs `GET /host-info`: tells the client whether — and how —
// it can open a path from the file panel in a local editor. Locality is
// declared via env, never inferred from the request's peer address alone —
// a loopback peer means "same machine" in a direct self-host setup, but
// could just as well be a reverse proxy tunneled through 127.0.0.1 in a
// different hosting topology, and a Tailscale-IP peer can still be the very
// same physical machine if the profile happens to point at its own tailnet
// address. The peer check below only ever downgrades a declared "local" to
// "ssh"/null; it never promotes an undeclared one.

export type EditorDescriptor = null | { kind: "local" } | { kind: "ssh"; user: string; host: string; port?: number };

export interface EditorEnv {
  ANYWH_EDITOR_LOCAL?: string;
  ANYWH_EDITOR_SSH?: string;
}

/** Strips the IPv4-mapped-IPv6 prefix Node uses for dual-stack sockets (`::ffff:127.0.0.1` -> `127.0.0.1`). */
function normalizePeerAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * Is `peerAddress` this machine — loopback, or a real address of one of its
 * own network interfaces? Used only to downgrade a declared `ANYWH_EDITOR_LOCAL`,
 * never to infer locality on its own (see file header).
 */
export function peerIsThisMachine(peerAddress: string | undefined): boolean {
  if (!peerAddress) return false;
  const normalized = normalizePeerAddress(peerAddress);
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.address === normalized) return true;
    }
  }
  return false;
}

/**
 * Parses `ANYWH_EDITOR_SSH=user@host[:port]`. Returns null on anything that
 * doesn't fit the shape (missing `@`, empty user/host, non-numeric port) —
 * treated identically to the variable being unset, rather than surfacing a
 * malformed-config error the file panel has no UI for.
 */
export function parseEditorSsh(raw: string | undefined): { user: string; host: string; port?: number } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0) return null;
  const user = trimmed.slice(0, atIndex);
  const rest = trimmed.slice(atIndex + 1);
  if (!rest) return null;

  const colonIndex = rest.lastIndexOf(":");
  if (colonIndex === -1) return { user, host: rest };

  const host = rest.slice(0, colonIndex);
  const port = Number(rest.slice(colonIndex + 1));
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { user, host, port };
}

/**
 * The three-branch resolution: declared local (and
 * confirmed same-machine) wins, then declared SSH, then null — which tells
 * the client to hide the "open in editor" feature entirely. Both variables
 * absent is the default, not an error.
 */
export function resolveEditorDescriptor(env: EditorEnv, peerAddress: string | undefined): EditorDescriptor {
  if (env.ANYWH_EDITOR_LOCAL === "1" && peerIsThisMachine(peerAddress)) {
    return { kind: "local" };
  }
  const ssh = parseEditorSsh(env.ANYWH_EDITOR_SSH);
  if (ssh) return { kind: "ssh", ...ssh };
  return null;
}
