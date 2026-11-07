// Types of fake-mcp.mjs, for the TypeScript tests that import it.
export function startFakeMcp(mode: "401-all" | "expire-on-call"): Promise<{ readonly url: string; close(): Promise<void> }>;
