import { describe, expect, it } from "vitest";
import { dropNestedPaths } from "@/lib/files/selection";

describe("dropNestedPaths", () => {
  it("drops children of a selected folder", () => {
    expect(dropNestedPaths(["/a/b", "/a/b/c.txt", "/a/b/d/e.txt", "/a/x.txt"])).toEqual(["/a/b", "/a/x.txt"]);
  });

  it("does not treat a sibling sharing a name prefix as nested", () => {
    expect(dropNestedPaths(["/a/b", "/a/bc"])).toEqual(["/a/b", "/a/bc"]);
  });

  it("dedupes repeated paths", () => {
    expect(dropNestedPaths(["/a", "/a"])).toEqual(["/a"]);
  });
});
