import { describe, expect, it } from "vitest";
import { EVENTS, FEATURES, ERROR_KINDS, effortOf, modelFamily, permissionModeOf, runtimeOf, validateEvent } from "@/lib/telemetry/events";

describe("validateEvent", () => {
  it("accepts exactly the schema", () => {
    expect(validateEvent("feature_used", { feature: "sala" })).toEqual({ feature: "sala" });
    expect(validateEvent("app_active", {})).toEqual({});
  });

  it("drops an event that is not in the registry", () => {
    expect(validateEvent("button_clicked", {})).toBeNull();
    expect(validateEvent("constructor", {})).toBeNull();
    expect(validateEvent("__proto__", {})).toBeNull();
  });

  it("drops an extra key instead of ignoring it", () => {
    expect(validateEvent("feature_used", { feature: "sala", path: "/home/x" })).toBeNull();
  });

  it("drops a missing required key and allows a missing optional one", () => {
    expect(validateEvent("feature_used", {})).toBeNull();
    expect(validateEvent("profile_added", { kind: "remote" })).toEqual({ kind: "remote" });
    expect(validateEvent("profile_added", { kind: "remote", pairing_method: "code" })).toEqual({ kind: "remote", pairing_method: "code" });
  });

  it("refuses free text where a closed list is expected", () => {
    expect(validateEvent("feature_used", { feature: "my-secret-project" })).toBeNull();
    expect(validateEvent("error_shown", { kind: "ECONNREFUSED 10.0.0.4:8080" })).toBeNull();
    expect(validateEvent("session_started", { runtime: "claude", model_family: "claude-opus-4-5", effort: "high", permission_mode: "plan", kind: "chat" })).toBeNull();
  });

  it("checks counts, booleans and lists", () => {
    const ok = {
      profile_count: 2,
      local_profiles: 1,
      remote_profiles: 1,
      runtimes_installed: ["claude", "codex"],
      update_mode: "notify",
      push_enabled: false,
      theme_kind: "builtin",
      font_size_bucket: "default",
    };
    expect(validateEvent("app_opened", ok)).toEqual(ok);
    expect(validateEvent("app_opened", { ...ok, profile_count: -1 })).toBeNull();
    expect(validateEvent("app_opened", { ...ok, profile_count: 1.5 })).toBeNull();
    expect(validateEvent("app_opened", { ...ok, push_enabled: "no" })).toBeNull();
    expect(validateEvent("app_opened", { ...ok, runtimes_installed: ["claude", "claude"] })).toBeNull();
    expect(validateEvent("app_opened", { ...ok, runtimes_installed: ["/usr/bin/claude"] })).toBeNull();
  });

  it("lets a version through only as a version", () => {
    expect(validateEvent("update_installed", { from_version: "0.1.7", to_version: "0.1.8", update_mode: "off" })).not.toBeNull();
    expect(validateEvent("update_installed", { from_version: "0.1.7", to_version: "see /home/wil/x", update_mode: "off" })).toBeNull();
  });

  it("has one registry entry per documented event and no others", () => {
    expect(Object.keys(EVENTS).sort()).toEqual(
      [
        "app_active",
        "app_opened",
        "error_shown",
        "feature_used",
        "first_prompt_sent",
        "first_run_completed",
        "first_run_step_viewed",
        "profile_added",
        "session_started",
        "telemetry_opted_out",
        "update_installed",
      ].sort(),
    );
    expect(FEATURES).toHaveLength(15);
    expect(ERROR_KINDS).toHaveLength(7);
  });
});

describe("reducers to closed lists", () => {
  it("reduces a model id to a family and never keeps the id", () => {
    expect(modelFamily("claude-opus-4-5")).toBe("opus");
    expect(modelFamily("opusplan")).toBe("opus");
    expect(modelFamily("sonnet[1m]")).toBe("sonnet");
    expect(modelFamily("gpt-5-codex")).toBe("gpt");
    expect(modelFamily("some-future-model")).toBe("other");
    expect(modelFamily(null)).toBe("other");
  });

  it("maps unknown runtimes, efforts and permission modes to other", () => {
    expect(runtimeOf("claude")).toBe("claude");
    expect(runtimeOf("my-agent")).toBe("other");
    expect(effortOf(null)).toBe("none");
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("turbo")).toBe("other");
    expect(permissionModeOf("acceptEdits")).toBe("acceptEdits");
    expect(permissionModeOf("custom-mode")).toBe("other");
  });
});
