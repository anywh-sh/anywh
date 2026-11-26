import { describe, expect, it } from "vitest";
import { breadcrumbsFor, folderName, parentOf } from "@/lib/files/folderPath";

describe("folderName", () => {
  it("is the last segment of the path", () => {
    expect(folderName("/home/wil/anywh")).toBe("anywh");
  });

  it("ignores trailing slashes", () => {
    expect(folderName("/home/wil/anywh//")).toBe("anywh");
  });

  it("is / for the root", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("parentOf", () => {
  it("drops the last segment", () => {
    expect(parentOf("/home/wil/anywh")).toBe("/home/wil");
  });

  it("goes up to the root, and stays there", () => {
    expect(parentOf("/home")).toBe("/");
    expect(parentOf("/")).toBe("/");
  });
});

describe("breadcrumbsFor", () => {
  it("gives each segment the path accumulated up to it", () => {
    expect(breadcrumbsFor("/home/wil")).toEqual([
      { label: "home", path: "/home" },
      { label: "wil", path: "/home/wil" },
    ]);
  });

  it("is a single / crumb for the root", () => {
    expect(breadcrumbsFor("/")).toEqual([{ label: "/", path: "/" }]);
  });
});
