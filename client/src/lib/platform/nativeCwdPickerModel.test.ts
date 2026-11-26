import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";
import { buildCwdPickerPayload, listErrorOf, type CwdPickerModelInput } from "./nativeCwdPickerModel";
import fixture from "../../../src-tauri/plugins/tauri-plugin-native-chrome/tests/fixtures/cwd_picker_payload.json";

const en = getDictionary("en");
const pt = getDictionary("pt-BR");

const theme: NativeShellTheme = {
  background: "#111111",
  sidebar: "#161616",
  elevated: "#1c1c1c",
  card: "#202020",
  foreground: "#eeeeee",
  muted: "#999999",
  faint: "#666666",
  border: "#2a2a2a",
  primary: "#e0642a",
  primaryForeground: "#ffffff",
  destructive: "#dc6f5c",
  tint: "#eceae4",
  success: "#e0642a",
};

const HOME = "/home/wil";
const CWD = "/home/wil/anywh/anywh";

function input(over: Partial<CwdPickerModelInput> = {}): CwdPickerModelInput {
  return {
    dict: en,
    theme,
    key: "session-1",
    cwd: CWD,
    home: HOME,
    recents: ["/home/wil/anywh/anywh-landing", CWD, "/srv/data"],
    listings: {
      [CWD]: {
        status: "ready",
        entries: [
          { name: ".github", path: `${CWD}/.github` },
          { name: "client", path: `${CWD}/client` },
          { name: "relay", path: `${CWD}/relay` },
        ],
        error: null,
      },
      [`${CWD}/client`]: { status: "loading", entries: [], error: null },
      "/root": { status: "error", entries: [], error: "permission_denied" },
    },
    lookup: { query: "~/anywh/anywh-ios", status: "found", path: "/home/wil/anywh/anywh-ios", error: null },
    flash: 1,
    ...over,
  };
}

describe("buildCwdPickerPayload", () => {
  it("is exactly the shared fixture the Rust side round-trips", () => {
    expect({ picker: buildCwdPickerPayload(input()) }).toEqual(fixture);
  });

  it("names the capsule after the folder and says the whole path to VoiceOver", () => {
    const payload = buildCwdPickerPayload(input());
    expect(payload.capsule).toEqual({ name: "anywh", accessibilityLabel: "Working directory: ~/anywh/anywh. Tap to change it." });
    expect(payload.current).toEqual({ path: CWD, name: "anywh", display: "~/anywh/anywh" });
  });

  it("leaves the current folder out of the recent ones", () => {
    const payload = buildCwdPickerPayload(input());
    expect(payload.recents.map((recent) => recent.path)).toEqual(["/home/wil/anywh/anywh-landing", "/srv/data"]);
    expect(payload.recents[1].display).toBe("/srv/data");
  });

  it("marks dot-folders and node_modules as hidden, and offers the way up", () => {
    const folder = buildCwdPickerPayload(input()).folders[CWD];
    expect(folder.entries.map((entry) => [entry.name, entry.hidden])).toEqual([
      [".github", true],
      ["client", false],
      ["relay", false],
    ]);
    expect(folder.parent).toEqual({ path: "/home/wil/anywh", name: "anywh", display: "~/anywh" });
    expect(folder.upLabel).toBe("Up to anywh");
  });

  it("has no way up from /", () => {
    const payload = buildCwdPickerPayload(input({ listings: { "/": { status: "ready", entries: [], error: null } } }));
    expect(payload.folders["/"].parent).toBeNull();
    expect(payload.folders["/"].upLabel).toBeNull();
  });

  it("words a folder the relay couldn't list", () => {
    expect(buildCwdPickerPayload(input()).folders["/root"].error).toEqual({
      title: "Couldn't read this folder",
      message: "The relay has no permission to list what's in it.",
    });
    const offline = buildCwdPickerPayload(input({ listings: { [CWD]: { status: "error", entries: [], error: "unreachable" } } }));
    expect(offline.folders[CWD].error?.message).toBe("The relay didn't answer. Check the connection and try again.");
  });

  it("gives a found path its whole chain, for the back stack", () => {
    const target = buildCwdPickerPayload(input()).lookup?.target;
    expect(target?.openLabel).toBe("Open anywh-ios");
    expect(target?.chain.map((folder) => folder.display)).toEqual(["/", "/home", "~", "~/anywh", "~/anywh/anywh-ios"]);
  });

  it("says where a typed path led nowhere", () => {
    const missing = buildCwdPickerPayload(input({ lookup: { query: "~/nope", status: "missing", path: "/home/wil/nope", error: "not_found" } })).lookup;
    expect(missing?.target).toBeNull();
    expect(missing?.error).toEqual({ title: "Folder not found", message: "Nothing at ~/nope on the relay's machine. Check the path." });
    const file = buildCwdPickerPayload(input({ lookup: { query: "/etc/hosts", status: "missing", path: "/etc/hosts", error: "not_a_directory" } })).lookup;
    expect(file?.error).toEqual({ title: "Folder not found", message: "That path is a file, not a folder." });
  });

  it("is still checking a path the relay hasn't answered for", () => {
    const checking = buildCwdPickerPayload(input({ lookup: { query: "/srv", status: "checking", path: null, error: null } })).lookup;
    expect(checking).toEqual({ query: "/srv", status: "checking", target: null, error: null });
  });

  it("keeps a folder name with $ in it as it is", () => {
    const payload = buildCwdPickerPayload(input({ cwd: "/home/wil/$&cash", listings: {} }));
    expect(payload.capsule.accessibilityLabel).toBe("Working directory: ~/$&cash. Tap to change it.");
  });

  it("shows absolute paths until the home folder is known", () => {
    const payload = buildCwdPickerPayload(input({ home: null }));
    expect(payload.home).toBeNull();
    expect(payload.current.display).toBe(CWD);
  });

  it("speaks the user's language", () => {
    const payload = buildCwdPickerPayload(input({ dict: pt }));
    expect(payload.strings.useFolder).toBe("Usar esta pasta");
    expect(payload.strings.showHidden).toBe("Mostrar pastas ocultas");
    expect(payload.folders[CWD].upLabel).toBe("Subir para anywh");
  });
});

describe("listErrorOf", () => {
  it("reads the relay's error code, and anything else as no answer", () => {
    expect(listErrorOf(new Error("permission_denied"))).toBe("permission_denied");
    expect(listErrorOf(new Error("HTTP 500"))).toBe("unreachable");
    expect(listErrorOf(new TypeError("Load failed"))).toBe("unreachable");
  });
});
