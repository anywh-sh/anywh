import { describe, expect, it } from "vitest";
import { ancestorsOf, breadcrumbsFor, displayPath, folderName, isHiddenFolder, isPathQuery, parentOf, resolvePathQuery } from "@/lib/files/folderPath";

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

describe("ancestorsOf", () => {
  it("lists every folder from the root down to the path", () => {
    expect(ancestorsOf("/home/wil/anywh")).toEqual(["/", "/home", "/home/wil", "/home/wil/anywh"]);
  });

  it("is just the root for the root", () => {
    expect(ancestorsOf("/")).toEqual(["/"]);
  });
});

describe("isHiddenFolder", () => {
  it("hides dot-folders and node_modules, like the relay", () => {
    expect(isHiddenFolder(".git")).toBe(true);
    expect(isHiddenFolder("node_modules")).toBe(true);
    expect(isHiddenFolder("src")).toBe(false);
  });
});

describe("displayPath", () => {
  it("writes the home folder as ~", () => {
    expect(displayPath("/home/wil", "/home/wil")).toBe("~");
    expect(displayPath("/home/wil/anywh", "/home/wil")).toBe("~/anywh");
  });

  it("leaves a sibling sharing the home folder's prefix alone", () => {
    expect(displayPath("/home/wilma", "/home/wil")).toBe("/home/wilma");
  });

  it("leaves paths as they are while home is unknown, or when home is /", () => {
    expect(displayPath("/home/wil", null)).toBe("/home/wil");
    expect(displayPath("/srv", "/")).toBe("/srv");
  });
});

describe("isPathQuery", () => {
  it("is a path when it starts with / or ~", () => {
    expect(isPathQuery(" /srv")).toBe(true);
    expect(isPathQuery("~/anywh")).toBe(true);
    expect(isPathQuery("anywh")).toBe(false);
    expect(isPathQuery("")).toBe(false);
  });
});

describe("resolvePathQuery", () => {
  it("expands ~ to the home folder", () => {
    expect(resolvePathQuery("~", "/home/wil")).toBe("/home/wil");
    expect(resolvePathQuery("~/anywh/", "/home/wil")).toBe("/home/wil/anywh");
  });

  it("can't expand ~ before the home folder is known", () => {
    expect(resolvePathQuery("~/anywh", null)).toBeNull();
  });

  it("keeps absolute paths, without trailing slashes", () => {
    expect(resolvePathQuery(" /srv/data// ", null)).toBe("/srv/data");
    expect(resolvePathQuery("/", null)).toBe("/");
  });

  it("leaves ~user for the relay to refuse", () => {
    expect(resolvePathQuery("~bob/x", "/home/wil")).toBe("~bob/x");
  });
});
