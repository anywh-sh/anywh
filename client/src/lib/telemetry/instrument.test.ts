import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAPER_THEME } from "@/lib/theme/builtinThemes";
import { setSelectedThemeId, setThemesForHost } from "@/lib/theme/themes";
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

const { themeKind, trackError, trackFeature, trackFirstRunCompleted, trackFirstRunStep, trackProfileAdded, trackPromptSent, trackSessionStarted } = await import(
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

  it("reports the first-run path from the flow taken, not from the profile's shape", () => {
    const localProfile = { host: "127.0.0.1", localRelay: true };
    trackFirstRunStep("preparing", "install");
    trackFirstRunCompleted(localProfile, ["claude"]);
    trackFirstRunStep("preparing", "adopt");
    trackFirstRunCompleted(localProfile, ["claude"]);
    trackFirstRunStep("other", "address");
    trackFirstRunCompleted({ host: "relay.example.com" }, ["claude"]);
    const paths = sent.filter((e) => e.name === "first_run_completed").map((e) => e.props.path);
    expect(paths).toEqual(["local_install", "adopt", "remote"]);
  });

  it("calls only an imported theme custom, never a built-in one", () => {
    expect(themeKind()).toBe("builtin");
    setSelectedThemeId(PAPER_THEME.id);
    expect(themeKind()).toBe("builtin");
    setThemesForHost("relay.example.com", [{ ...PAPER_THEME, id: "imported-one", name: "Imported" }]);
    setSelectedThemeId("imported-one");
    expect(themeKind()).toBe("custom");
    setSelectedThemeId("gone");
    expect(themeKind()).toBe("builtin");
    setSelectedThemeId(null);
  });

  it("never lets an unknown agent, model or mode through as text", () => {
    trackSessionStarted({ agentId: "my-private-agent", model: "something/odd", effort: "weird", permissionMode: "custom", kind: "chat" });
    expect(sent[0]?.props).toEqual({ runtime: "other", model_family: "other", effort: "other", permission_mode: "other", kind: "chat" });
  });
});
