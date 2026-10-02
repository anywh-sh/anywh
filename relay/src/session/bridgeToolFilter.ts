import type { AgentEvent } from "../protocol/agent-event.js";

/**
 * The relay's own MCP bridges — the structured-question and approval servers
 * — reach the model as ordinary MCP tools, so every def reports their calls
 * like any other. They already have a surface of their own (the choice card,
 * the approval prompt), and a row saying "called present_choice" beside it
 * is noise. Recognized by the `subject.server` a def maps every MCP call
 * into, which is why a new def needs no declaration for this to work.
 */
const BRIDGE_SERVERS: ReadonlySet<string> = new Set(["anywh-choice", "anywh-permission"]);

/** Stateful because a call's result and its context attribution carry only
 * the call's id, not its server: the id is remembered from the start. One
 * instance per turn live, per replay when reading history. */
export class BridgeToolFilter {
  private readonly hidden = new Set<string>();

  /** `true` when the event belongs to a bridge call and must not be shown. */
  shouldHide(event: AgentEvent): boolean {
    if (event.type === "tool_started") {
      if (event.subject?.kind !== "mcp" || !BRIDGE_SERVERS.has(event.subject.server)) return false;
      if (event.toolUseId) this.hidden.add(event.toolUseId);
      return true;
    }
    if (event.type === "tool_ended") return event.toolUseId !== undefined && this.hidden.has(event.toolUseId);
    if (event.type === "context_attribution") return event.toolUseIds.length > 0 && event.toolUseIds.every((id) => this.hidden.has(id));
    return false;
  }
}
