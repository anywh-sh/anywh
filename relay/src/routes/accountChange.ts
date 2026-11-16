import type { RouteContext } from "./context.js";

/** What a sign-in or sign-out makes stale: idle daemons started under the
 * old credentials, and plan usage read (or cached) under them. Neither waits
 * on the other, and neither holds up the answer to the person. */
export function afterAccountChange(runtimeId: string, ctx: RouteContext): void {
  const recycled = ctx.sessionManager.recycleAgentProcesses(runtimeId);
  if (recycled > 0) console.log(`[relay] ${runtimeId} account changed: let ${String(recycled)} idle session process(es) go`);
  ctx.planUsage.accountChanged(runtimeId).catch((error: unknown) => {
    console.warn(`[relay] ${runtimeId} plan usage re-read after an account change failed:`, (error as Error).message);
  });
}
