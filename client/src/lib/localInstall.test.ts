import { describe, expect, it } from "vitest";
import { evaluatePrerequisites, failureActions, toFailureCode, type LocalFailureCode } from "./localInstall";
import type { Prerequisites } from "./localRelay";

const healthy: Prerequisites = {
  nodePath: "/usr/bin/node",
  nodeVersion: "22.4.0",
  nodeOk: true,
  agentBin: "claude",
  agentPath: "/home/x/.local/bin/claude",
  agentLoggedIn: true,
  agentError: null,
  systemdUser: true,
  xdgRuntimeDir: true,
  activeUnits: [],
};

describe("evaluatePrerequisites", () => {
  it("passes a healthy machine", () => {
    expect(evaluatePrerequisites(healthy, "prod")).toBeNull();
  });

  it("names the first thing to fix, in the order a person would fix them", () => {
    expect(evaluatePrerequisites({ ...healthy, nodePath: null, nodeOk: false, agentPath: null }, "prod")?.code).toBe("node_missing");
    expect(evaluatePrerequisites({ ...healthy, nodeOk: false, nodeVersion: "18.20.4" }, "prod")).toEqual({ code: "node_old", detail: "18.20.4" });
    expect(evaluatePrerequisites({ ...healthy, agentPath: null }, "prod")?.code).toBe("agent_missing");
  });

  it("a logged-out agent comes with the command to copy, built from the configured binary", () => {
    const failure = evaluatePrerequisites({ ...healthy, agentBin: "/opt/agent/bin/claude", agentLoggedIn: false }, "prod");
    expect(failure?.code).toBe("agent_not_logged_in");
    expect(failure?.command).toBe("/opt/agent/bin/claude login");
    // `null` (the CLI couldn't be asked) is not a yes either.
    expect(evaluatePrerequisites({ ...healthy, agentLoggedIn: null, agentError: "timed out" }, "prod")).toMatchObject({ code: "agent_not_logged_in", detail: "timed out" });
  });

  it("refuses to install under a running relay", () => {
    expect(evaluatePrerequisites({ ...healthy, activeUnits: ["anywh-relay@home.service"] }, "prod")?.code).toBe("relay_running");
  });

  it("only needs systemd --user when a service is going to be registered", () => {
    expect(evaluatePrerequisites({ ...healthy, systemdUser: false }, "prod")?.code).toBe("no_user_systemd");
    expect(evaluatePrerequisites({ ...healthy, systemdUser: false }, "dev")).toBeNull();
  });
});

describe("failureActions", () => {
  it("never offers a blind retry for a checksum mismatch", () => {
    expect(failureActions("checksum_mismatch")).not.toContain("retry");
    expect(failureActions("tarball_incomplete")).not.toContain("retry");
  });

  it("offers dev mode only for the missing service manager", () => {
    const withDevMode = (["node_missing", "node_old", "agent_missing", "agent_not_logged_in", "no_user_systemd", "download_failed"] as LocalFailureCode[]).filter((code) =>
      failureActions(code).includes("useDevMode"),
    );
    expect(withDevMode).toEqual(["no_user_systemd"]);
  });

  it("every code has at least one way out", () => {
    const codes: LocalFailureCode[] = [
      "node_missing", "node_old", "agent_missing", "agent_not_logged_in", "no_user_systemd", "containerized", "relay_running",
      "relay_host_undetectable", "download_failed", "checksum_missing", "checksum_mismatch", "extract_failed", "tarball_incomplete",
      "service_failed", "profile_failed", "cancelled", "interrupted", "start_failed", "unexpected",
    ];
    for (const code of codes) expect(failureActions(code).length, code).toBeGreaterThan(0);
  });
});

describe("toFailureCode", () => {
  it("passes the installer's codes through and folds unknown ones into unexpected", () => {
    expect(toFailureCode("checksum_mismatch")).toBe("checksum_mismatch");
    expect(toFailureCode("bad_flag")).toBe("unexpected");
    expect(toFailureCode("something_new")).toBe("unexpected");
  });
});
