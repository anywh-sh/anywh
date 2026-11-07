// What a direct MCP tool call came back with, read the same way for every
// CLI: both hand over the server's raw `CallToolResult` (`{content,
// structuredContent?, isError?, _meta?}`), Claude's `mcp_call` possibly
// wrapped once more in `{result}`.
//
// Pure.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The most of a failure's text kept: enough for a log or a tooltip. */
const MESSAGE_LIMIT = 300;

export type ToolCallOutcome =
  /** `value` is `structuredContent`, or the first text block parsed as JSON. */
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      /** `tool`: the server answered with an error result; `transport`: the
       * CLI could not get an answer (the call itself failed); `parse`: an
       * answer this relay cannot read. */
      readonly kind: "tool" | "transport" | "parse";
      readonly message: string;
      /** The server asked for a sign-in in a structured way (an MCP
       * `WWW-Authenticate` challenge). */
      readonly authChallenge?: boolean;
      /** The call timed out or the process went away. */
      readonly unreachable?: boolean;
    };

const cut = (text: string): string => (text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text);

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** A `CallToolResult` as an outcome. */
export function readCallToolResult(raw: unknown): ToolCallOutcome {
  const result = isRecord(raw) && isRecord(raw.result) && !("content" in raw) ? raw.result : raw;
  if (!isRecord(result)) return { ok: false, kind: "parse", message: "not a tool result" };
  if (result.isError === true) {
    const meta = isRecord(result._meta) ? result._meta : {};
    const authChallenge = meta["mcp/www_authenticate"] !== undefined;
    return { ok: false, kind: "tool", message: cut(textOf(result.content) || "tool error"), ...(authChallenge ? { authChallenge } : {}) };
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) return { ok: true, value: result.structuredContent };
  const text = textOf(result.content);
  if (text === "") return { ok: false, kind: "parse", message: "empty tool result" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, kind: "parse", message: "tool result is not JSON" };
  }
}

/** A call that got no result at all (the CLI's own error, a timeout). */
export function transportFailure(error: unknown): ToolCallOutcome {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const unreachable = /Timeout|Exited/.test(name) || /timed out|exited|ECONNREFUSED|ENOENT/i.test(message);
  return { ok: false, kind: "transport", message: cut(message), ...(unreachable ? { unreachable } : {}) };
}

/** The value of a call the agent made, from the plain text its CLI reported
 * (`tool_ended.content`): Codex hands over the whole `CallToolResult` as
 * JSON, Claude the result's text, which a JSON-speaking server fills with
 * the value itself. `undefined` for anything else. */
export function observedToolValue(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const blocks = isRecord(parsed) ? parsed.content : undefined;
  if (Array.isArray(blocks) && blocks.every((block) => isRecord(block) && typeof block.type === "string")) {
    const outcome = readCallToolResult(parsed);
    return outcome.ok ? outcome.value : undefined;
  }
  return parsed;
}
