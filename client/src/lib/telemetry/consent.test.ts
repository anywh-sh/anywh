import { describe, expect, it } from "vitest";
import { envFlagSet, isPending, resolveConsent } from "@/lib/telemetry/consent";

describe("resolveConsent", () => {
  it("lets the environment beat every saved choice", () => {
    expect(resolveConsent(true, true)).toBe("disabled_by_env");
    expect(resolveConsent(true, false)).toBe("disabled_by_env");
    expect(resolveConsent(true, null)).toBe("disabled_by_env");
  });

  it("lets a saved no beat a saved yes only through the same value", () => {
    expect(resolveConsent(false, false)).toBe("disabled_by_user");
    expect(resolveConsent(false, true)).toBe("enabled");
  });

  it("waits for the banner when nothing was ever chosen", () => {
    expect(resolveConsent(false, null)).toBe("pending_banner");
  });

  it("does not call an unread environment 'enabled', even for a saved yes", () => {
    expect(resolveConsent(null, true)).toBe("pending_env");
    expect(resolveConsent(null, null)).toBe("pending_env");
  });

  it("still honours a saved no while the environment is unread", () => {
    expect(resolveConsent(null, false)).toBe("disabled_by_user");
  });

  it("holds events only in the two pending states", () => {
    expect(["enabled", "disabled_by_env", "disabled_by_user", "pending_banner", "pending_env"].filter((s) => isPending(s as never))).toEqual([
      "pending_banner",
      "pending_env",
    ]);
  });
});

describe("envFlagSet", () => {
  it.each([["1", true], ["true", true], ["yes", true], [" 1 ", true], ["0", false], ["false", false], ["FALSE", false], ["", false], [undefined, false]])(
    "%j -> %s",
    (value, expected) => {
      expect(envFlagSet(value)).toBe(expected);
    },
  );
});
