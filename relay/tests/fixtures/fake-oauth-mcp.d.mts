// Types of fake-oauth-mcp.mjs, for the TypeScript tests that import it.
export interface FakeOAuthMcp {
  /** The protected MCP endpoint. */
  readonly url: string;
  readonly base: string;
  /** The redirect URIs of every client registration, in order. */
  readonly registrations: string[][];
  /** The tools called, in order. */
  readonly calls: string[];
  admin(options?: { revoke?: boolean; fails?: boolean; ttl?: number; rotating?: boolean }): void;
  close(): Promise<void>;
}
export function startFakeOAuthMcp(options?: { rejectCustomRedirect?: boolean; accessTtlSecs?: number }): Promise<FakeOAuthMcp>;
export function consent(authUrl: string): Promise<string>;
