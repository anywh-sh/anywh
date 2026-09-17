import { describe, expect, it } from "vitest";
import { buildEditorUrl } from "./editorLinks";

describe("buildEditorUrl", () => {
  it("returns null when locality is null (both env vars unset relay-side)", () => {
    expect(buildEditorUrl("zed", null, { path: "/home/user/project" })).toBeNull();
  });

  it("builds the local form for Zed", () => {
    expect(buildEditorUrl("zed", { kind: "local" }, { path: "/home/user/project/notes.txt" })).toBe(
      "zed://file/home/user/project/notes.txt",
    );
  });

  it("builds the local form for the VS Code family", () => {
    const target = { path: "/home/user/project" };
    expect(buildEditorUrl("vscode", { kind: "local" }, target)).toBe("vscode://file/home/user/project");
    expect(buildEditorUrl("cursor", { kind: "local" }, target)).toBe("cursor://file/home/user/project");
    expect(buildEditorUrl("windsurf", { kind: "local" }, target)).toBe("windsurf://file/home/user/project");
  });

  it("builds Zed's ssh form as user@host directly concatenated with the path", () => {
    const url = buildEditorUrl("zed", { kind: "ssh", user: "wil", host: "debian-headless" }, { path: "/home/wil/project" });
    expect(url).toBe("zed://ssh/wil@debian-headless/home/wil/project");
  });

  it("builds the VS Code family's ssh-remote form", () => {
    const url = buildEditorUrl("vscode", { kind: "ssh", user: "wil", host: "debian-headless" }, { path: "/home/wil/project" });
    expect(url).toBe("vscode://vscode-remote/ssh-remote+wil@debian-headless/home/wil/project");
  });

  it("includes the port when present, for both Zed and the VS Code family", () => {
    const locality = { kind: "ssh" as const, user: "wil", host: "100.64.0.1", port: 2222 };
    expect(buildEditorUrl("zed", locality, { path: "/home/wil/project" })).toBe("zed://ssh/wil@100.64.0.1:2222/home/wil/project");
    expect(buildEditorUrl("cursor", locality, { path: "/home/wil/project" })).toBe(
      "cursor://vscode-remote/ssh-remote+wil@100.64.0.1:2222/home/wil/project",
    );
  });

  it("rewrites a Windows drive path with forward slashes and a leading slash, preserving the drive letter's colon", () => {
    const url = buildEditorUrl("vscode", { kind: "local" }, { path: "C:\\Users\\wil\\notes.txt" });
    expect(url).toBe("vscode://file/C:/Users/wil/notes.txt");
  });

  it("percent-encodes spaces, '#', and accented characters in path segments, but never the '/' separators", () => {
    const url = buildEditorUrl("zed", { kind: "local" }, { path: "/home/wil/my project/notas #1 café.txt" });
    expect(url).toBe("zed://file/home/wil/my%20project/notas%20%231%20caf%C3%A9.txt");
  });

  it("never percent-encodes the '@' or the port's ':' in the ssh authority, even though the path encoder would mangle them", () => {
    const url = buildEditorUrl("vscode", { kind: "ssh", user: "wil", host: "debian-headless", port: 2222 }, { path: "/home/wil/x" });
    expect(url).toContain("ssh-remote+wil@debian-headless:2222/");
    expect(url).not.toContain("%40");
    expect(url).not.toContain("%3A2222");
  });

  it("appends an optional line, or line:column, suffix", () => {
    expect(buildEditorUrl("zed", { kind: "local" }, { path: "/home/wil/x.ts", line: 42 })).toBe("zed://file/home/wil/x.ts:42");
    expect(buildEditorUrl("zed", { kind: "local" }, { path: "/home/wil/x.ts", line: 42, column: 7 })).toBe(
      "zed://file/home/wil/x.ts:42:7",
    );
  });
});
