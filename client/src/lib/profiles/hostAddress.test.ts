import { describe, expect, it } from "vitest";
import { isValidHost } from "./hostAddress";

describe("isValidHost", () => {
  it("takes host names and IP addresses", () => {
    for (const host of ["127.0.0.1", "relay.home.example", "my-box", "100.64.0.1", "::1", "[fe80::1]"]) expect(isValidHost(host), host).toBe(true);
  });

  it("refuses anything a shell or a URL would read as more than an address", () => {
    for (const host of ["", "a b", "x;rm -rf ~", "a|b", "a&b", "$(id)", "`id`", "a/b", "user@host", "a'b"]) expect(isValidHost(host), host).toBe(false);
  });
});
