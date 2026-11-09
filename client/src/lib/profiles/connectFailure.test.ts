import { describe, expect, it } from "vitest";
import { addressClassOf, connectFailureReasonOf } from "./connectFailure";

describe("addressClassOf", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["localhost", "loopback"],
    ["LOCALHOST.", "loopback"],
    ["relay.localhost", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.0.0.5", "private_lan"],
    ["172.16.0.1", "private_lan"],
    ["172.31.255.255", "private_lan"],
    ["192.168.1.20", "private_lan"],
    ["169.254.3.4", "private_lan"],
    ["fc00::1", "private_lan"],
    ["fd12:3456::1", "private_lan"],
    ["fe80::1%en0", "private_lan"],
    ["[fe80::abcd]", "private_lan"],
    ["::ffff:192.168.1.20", "private_lan"],
    ["100.64.0.1", "tailscale"],
    ["100.100.50.2", "tailscale"],
    ["100.127.255.254", "tailscale"],
    ["fd7a:115c:a1e0::1", "tailscale"],
    ["box.tail1234.ts.net", "tailscale"],
    ["Box.Tail1234.TS.NET.", "tailscale"],
    ["8.8.8.8", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["172.15.0.1", "public"],
    ["172.32.0.1", "public"],
    ["192.169.0.1", "public"],
    ["2001:db8::1", "public"],
    ["relay.example.com", "hostname"],
    ["my-mac.local", "hostname"],
    ["10.0.0.5.example.com", "hostname"],
    ["300.1.1.1", "hostname"],
    ["", "hostname"],
  ])("%s is %s", (host, expected) => {
    expect(addressClassOf(host)).toBe(expected);
  });

  it("is brokered for a profile that dials through the sidecar, whatever its placeholder host says", () => {
    expect(addressClassOf("127.0.0.1", true)).toBe("brokered");
  });
});

describe("connectFailureReasonOf", () => {
  it("is unreachable for a fetch that got no answer — the browser cannot say refused", () => {
    expect(connectFailureReasonOf(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(connectFailureReasonOf(new TypeError("Load failed"))).toBe("unreachable");
    expect(connectFailureReasonOf(new TypeError("anything"))).toBe("unreachable");
  });

  it("reads refused, timeout and unreachable from text that names them", () => {
    expect(connectFailureReasonOf(new Error("dial tcp 100.64.0.1:8765: connect: connection refused"))).toBe("refused");
    expect(connectFailureReasonOf("connect ECONNREFUSED")).toBe("refused");
    expect(connectFailureReasonOf(new Error("context deadline exceeded"))).toBe("timeout");
    expect(connectFailureReasonOf(new Error("operation timed out"))).toBe("timeout");
    expect(connectFailureReasonOf(new Error("no route to host"))).toBe("unreachable");
  });

  it("is auth for a 401/403 status or a revoked device", () => {
    expect(connectFailureReasonOf(new Error("claim failed (401)"))).toBe("auth");
    expect(connectFailureReasonOf(new Error("broker refused the connection request (403)"))).toBe("auth");
    const revoked = new Error("revoked");
    revoked.name = "BrokerRevokedError";
    expect(connectFailureReasonOf(revoked)).toBe("auth");
  });

  it("is other for anything it cannot place, rather than a guess", () => {
    expect(connectFailureReasonOf(new Error("claim response missing nodeId/controlUrl/authKey"))).toBe("other");
    expect(connectFailureReasonOf(new Error("broker refused the connection request (500)"))).toBe("other");
    expect(connectFailureReasonOf(undefined)).toBe("other");
    expect(connectFailureReasonOf({})).toBe("other");
  });
});
