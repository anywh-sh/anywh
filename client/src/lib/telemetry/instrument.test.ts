import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS, ERROR_KINDS, FEATURES, validateEvent } from "@/lib/telemetry/events";

const sent: { name: string; props: Record<string, unknown> }[] = [];
vi.mock("@/lib/telemetry", () => {
  const record = (name: string, props: Record<string, unknown>) => {
    sent.push({ name, props });
    return "sent";
  };
  return {
    telemetry: {
      available: true,
      track: record,
      trackDaily: (_key: string, name: string, props: Record<string, unknown>) => record(name, props),
      trackOnce: (_key: string, name: string, props: Record<string, unknown>) => record(name, props),
    },
  };
});

const { trackError, trackFeature, trackFirstRunCompleted, trackFirstRunStep, trackProfileAdded, trackPromptSent, trackSessionStarted } = await import(
  "@/lib/telemetry/instrument"
);

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
});

describe("instrument helpers", () => {
  it("every payload they build passes the registry schema", () => {
    for (const feature of FEATURES) trackFeature(feature);
    for (const kind of ERROR_KINDS) trackError(kind);
    trackSessionStarted({ agentId: "claude", model: "claude-opus-4-5", effort: "high", permissionMode: "acceptEdits", kind: "chat" });
    trackSessionStarted({ agentId: "my-private-agent", model: "something/odd", effort: "weird", permissionMode: "custom", kind: "sala" });
    trackPromptSent("codex");
    trackProfileAdded({ host: "127.0.0.1" });
    trackProfileAdded({ host: "relay.example.com" });
    trackProfileAdded({ host: "127.0.0.1", brokerNodeId: "n1" });
    trackFirstRunStep("welcome", undefined);
    trackFirstRunStep("preparing", "install");
    trackFirstRunCompleted({ host: "127.0.0.1", localRelay: true }, ["claude", "codex", "unknown-agent"]);
    trackFirstRunCompleted(undefined, []);
    expect(sent.length).toBeGreaterThan(20);
    for (const { name, props } of sent) {
      expect(name in EVENTS).toBe(true);
      expect(validateEvent(name, props), `${name} ${JSON.stringify(props)}`).not.toBeNull();
    }
  });

  it("never lets an unknown agent, model or mode through as text", () => {
    trackSessionStarted({ agentId: "my-private-agent", model: "something/odd", effort: "weird", permissionMode: "custom", kind: "chat" });
    expect(sent[0]?.props).toEqual({ runtime: "other", model_family: "other", effort: "other", permission_mode: "other", kind: "chat" });
  });
});
