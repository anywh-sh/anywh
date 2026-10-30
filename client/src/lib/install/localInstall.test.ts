import { describe, expect, it } from "vitest";
import {
  evaluatePrerequisites,
  failureActions,
  preparingFailure,
  preparingOutcome,
  preparingSteps,
  toFailureCode,
  type LocalInstallState,
  type PreparingFailureCode,
} from "./localInstall";
import type { InstallLogLine, Prerequisites } from "./localRelay";

const healthy: Prerequisites = {
  nodePath: "/usr/bin/node",
  nodeVersion: "22.4.0",
  nodeOk: true,
  brewPath: null,
  systemdUser: true,
  xdgRuntimeDir: true,
  activeUnits: [],
};

describe("evaluatePrerequisites", () => {
  it("passes a healthy machine", () => {
    expect(evaluatePrerequisites(healthy, "prod", "linux")).toBeNull();
  });

  it("names the first thing to fix, in the order a person would fix them", () => {
    expect(evaluatePrerequisites({ ...healthy, nodePath: null, nodeOk: false }, "prod", "linux")?.code).toBe("node_missing");
    expect(evaluatePrerequisites({ ...healthy, nodeOk: false, nodeVersion: "18.20.4" }, "prod", "linux")).toEqual({ code: "node_old", detail: "18.20.4" });
  });

  it("refuses to install under a running relay", () => {
    expect(evaluatePrerequisites({ ...healthy, activeUnits: ["anywh-relay@home.service"] }, "prod", "linux")?.code).toBe("relay_running");
  });

  it("only needs systemd --user when a service is going to be registered", () => {
    expect(evaluatePrerequisites({ ...healthy, systemdUser: false }, "prod", "linux")?.code).toBe("no_user_systemd");
    expect(evaluatePrerequisites({ ...healthy, systemdUser: false }, "dev", "linux")).toBeNull();
  });

  it("defaults to the Linux checklist outside Tauri", () => {
    // `currentPlatform()` answers `null` in a test environment (no Tauri) —
    // the same checklist a real Linux machine gets, not a silent no-op.
    expect(evaluatePrerequisites({ ...healthy, nodePath: null }, "prod")?.code).toBe("node_missing");
  });

  it("macOS checks Homebrew instead of Node, and never asks about systemd", () => {
    const macHealthy: Prerequisites = { ...healthy, nodePath: null, nodeOk: false, brewPath: "/opt/homebrew/bin/brew" };
    expect(evaluatePrerequisites(macHealthy, "prod", "macos")).toBeNull();
    expect(evaluatePrerequisites({ ...macHealthy, brewPath: null }, "prod", "macos")?.code).toBe("brew_missing");
    // Neither field means anything on macOS — relay_setup.rs never
    // populates them there, and a stale/mocked `true`/non-empty value must
    // not block an otherwise healthy machine.
    expect(evaluatePrerequisites({ ...macHealthy, systemdUser: false, activeUnits: ["anywh-relay@home.service"] }, "prod", "macos")).toBeNull();
  });
});

describe("failureActions", () => {
  const ALL: PreparingFailureCode[] = [
    "node_missing", "node_old", "no_user_systemd", "containerized", "relay_running", "relay_host_undetectable",
    "download_failed", "checksum_missing", "checksum_mismatch", "extract_failed", "tarball_incomplete",
    "service_failed", "profile_failed", "cancelled", "interrupted", "start_failed", "unexpected",
    "brew_missing", "brew_install_failed", "unsupported_arch", "unresponsive",
  ];

  it("never offers a blind retry for a checksum mismatch", () => {
    expect(failureActions("checksum_mismatch")).toEqual(["terminal", "back"]);
    expect(failureActions("tarball_incomplete")).toEqual(["terminal", "back"]);
  });

  it("never offers dev mode from a failure — it lives in the advanced options", () => {
    // A machine without systemd --user is pointed at the terminal, where
    // choosing to run without a service is deliberate.
    expect(failureActions("no_user_systemd")).toEqual(["terminal"]);
    expect(failureActions("containerized")).toEqual(["terminal"]);
  });

  it("a missing runtime is checked again, a stopped install is tried again", () => {
    expect(failureActions("node_missing")).toEqual(["recheck", "terminal"]);
    expect(failureActions("node_old")).toEqual(["recheck", "terminal"]);
    expect(failureActions("brew_missing")).toEqual(["recheck", "terminal"]);
    for (const code of ["download_failed", "brew_install_failed", "service_failed", "profile_failed", "start_failed", "unexpected"] as const) {
      expect(failureActions(code), code).toEqual(["retry", "terminal"]);
    }
  });

  it("a relay that is installed but doesn't answer is tried again, not reinstalled from scratch", () => {
    expect(failureActions("unresponsive")).toEqual(["retry", "terminal"]);
  });

  it("an Intel Mac is pointed at another machine, never at a retry", () => {
    expect(failureActions("unsupported_arch")).toEqual(["otherMachine", "back"]);
  });

  it("every code has at least one way out", () => {
    for (const code of ALL) expect(failureActions(code).length, code).toBeGreaterThan(0);
  });
});

function line(seq: number, text: string): InstallLogLine {
  const [, verb, step] = text.split(" ");
  const event: InstallLogLine["event"] =
    verb === "step" ? { kind: "step", step } : verb === "done" ? { kind: "done", step, fields: {} } : verb === "fail" ? { kind: "fail", step, code: "x", message: "" } : null;
  return { seq, line: text, event };
}

function lines(...texts: string[]): InstallLogLine[] {
  return texts.map((text, index) => line(index + 1, text));
}

function stateWith(patch: {
  prereqs?: Partial<LocalInstallState["prereqs"]>;
  install?: Partial<LocalInstallState["install"]>;
  verify?: Partial<LocalInstallState["verify"]>;
}): LocalInstallState {
  return {
    note: "none",
    mode: "prod",
    params: { label: "Personal", host: "127.0.0.1", profileId: "default" },
    prereqs: { status: "ok", result: healthy, failure: null, ...patch.prereqs },
    install: { runId: "r", lines: [], status: "idle", failure: null, failedStep: null, profile: null, ...patch.install },
    verify: { status: "idle", profileId: null, failure: null, ...patch.verify },
  };
}

const statuses = (state: LocalInstallState) => preparingSteps(state).map((step) => step.status);

describe("preparingSteps", () => {
  it("the client's own check is the first step", () => {
    expect(statuses(stateWith({ prereqs: { status: "running" } }))).toEqual(["running", "pending", "pending"]);
    expect(statuses(stateWith({ prereqs: { status: "failed", failure: { code: "node_missing", detail: "" } } }))).toEqual(["failed", "pending", "pending"]);
  });

  it("groups the Linux installer's steps into check, install and start", () => {
    const running = (texts: string[]) => statuses(stateWith({ install: { status: "running", lines: lines(...texts) } }));
    expect(running([])).toEqual(["running", "pending", "pending"]);
    expect(running(["ANYWH step flags", "ANYWH done flags", "ANYWH step target", "ANYWH step prereqs"])).toEqual(["running", "pending", "pending"]);
    expect(running(["ANYWH done prereqs", "ANYWH step relay_host"])).toEqual(["done", "running", "pending"]);
    expect(running(["ANYWH step download", "ANYWH done download", "ANYWH step install"])).toEqual(["done", "running", "pending"]);
    expect(running(["ANYWH step install", "ANYWH done install", "ANYWH step service"])).toEqual(["done", "done", "running"]);
  });

  it("groups the macOS installer's order (profile before service) the same way", () => {
    const running = (texts: string[]) => statuses(stateWith({ install: { status: "running", lines: lines(...texts) } }));
    expect(running(["ANYWH done prereqs", "ANYWH step install"])).toEqual(["done", "running", "pending"]);
    expect(running(["ANYWH done install", "ANYWH step profile"])).toEqual(["done", "done", "running"]);
    expect(running(["ANYWH done profile", "ANYWH step service"])).toEqual(["done", "done", "running"]);
  });

  it("the step the installer failed on is the one marked, and the earlier ones stay done", () => {
    const failed = stateWith({
      install: { status: "failed", lines: lines("ANYWH done prereqs", "ANYWH step download", "ANYWH fail download"), failedStep: "download", failure: { code: "checksum_mismatch", detail: "" } },
    });
    expect(statuses(failed)).toEqual(["done", "failed", "pending"]);
    expect(preparingFailure(failed)?.code).toBe("checksum_mismatch");
  });

  it("a run that died with no step to blame marks the furthest step it reached", () => {
    const died = stateWith({ install: { status: "failed", lines: lines("ANYWH step service"), failure: { code: "unexpected", detail: "" } } });
    expect(statuses(died)).toEqual(["done", "done", "failed"]);
  });

  it("start is done only once the new profile answers", () => {
    const installed = { status: "ok" as const, profile: { id: "default", port: 8765, host: "127.0.0.1", mode: "prod" } };
    expect(statuses(stateWith({ install: installed, verify: { status: "running", profileId: "default" } }))).toEqual(["done", "done", "running"]);
    const silent = stateWith({ install: installed, verify: { status: "failed", profileId: "default", failure: { code: "unresponsive", detail: "" } } });
    expect(statuses(silent)).toEqual(["done", "done", "failed"]);
    expect(preparingOutcome(silent)).toBe("failed");
    const ready = stateWith({ install: installed, verify: { status: "ok", profileId: "default" } });
    expect(statuses(ready)).toEqual(["done", "done", "done"]);
    expect(preparingOutcome(ready)).toBe("ready");
  });

});

describe("toFailureCode", () => {
  it("passes the installer's codes through and folds unknown ones into unexpected", () => {
    expect(toFailureCode("checksum_mismatch")).toBe("checksum_mismatch");
    expect(toFailureCode("bad_flag")).toBe("unexpected");
    expect(toFailureCode("something_new")).toBe("unexpected");
  });
});
