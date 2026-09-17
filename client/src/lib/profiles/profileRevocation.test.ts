import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProfileRevoked,
  isProfileRevoked,
  markProfileRevoked,
  subscribeProfileRevocation,
} from "@/lib/profiles/profileRevocation";

afterEach(() => {
  clearProfileRevoked("a");
  clearProfileRevoked("b");
});

describe("profileRevocation", () => {
  it("starts with no profile revoked", () => {
    expect(isProfileRevoked("a")).toBe(false);
  });

  it("marks a profile revoked and notifies subscribers exactly once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProfileRevocation(listener);

    markProfileRevoked("a");
    markProfileRevoked("a"); // idempotent — already revoked, no second notify

    expect(isProfileRevoked("a")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps profiles independent of each other", () => {
    markProfileRevoked("a");
    expect(isProfileRevoked("a")).toBe(true);
    expect(isProfileRevoked("b")).toBe(false);
  });

  it("clears a revoked profile and notifies subscribers", () => {
    markProfileRevoked("a");
    const listener = vi.fn();
    const unsubscribe = subscribeProfileRevocation(listener);

    clearProfileRevoked("a");
    clearProfileRevoked("a"); // idempotent — already clear, no second notify

    expect(isProfileRevoked("a")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
