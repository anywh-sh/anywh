// Why a call to an MCP server's tool failed, from what the agent's CLI
// wrote about it — each def declares how its CLI words a failure
// (`McpFailureClassifier`), this applies it. Pure.
import type { McpFailureReason } from "../protocol/agent-event.js";
import type { McpFailureClassifier } from "./types.js";

/** A failed call as the CLI reported it: the error text, and the result's
 * `_meta` when the server answered with one. */
export interface McpFailureReport {
  readonly text: string;
  readonly meta?: unknown;
}

export function classifyMcpFailure(classifier: McpFailureClassifier, report: McpFailureReport): McpFailureReason {
  const meta = report.meta;
  if (meta !== null && typeof meta === "object" && classifier.authMetaKeys?.some((key) => (meta as Record<string, unknown>)[key] !== undefined)) return "auth";
  for (const rule of classifier.rules) {
    if (rule.pattern.test(report.text)) return rule.reason;
  }
  return "server_error";
}
