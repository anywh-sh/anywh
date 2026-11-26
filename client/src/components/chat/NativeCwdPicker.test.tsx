import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { NativeCwdPickerPayload } from "@/lib/platform/nativeCwdPicker";
import type { Profile } from "@/lib/profiles/profiles";
import type { FsListResult } from "@/lib/relay/fsBrowse";

// The native picker is one boundary here: stand in for the plugin's IPC,
// keeping the handlers the component registers so a test can fire what native
// would. The relay's folder listing is the other, as in FolderPickerDialog's
// test.
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  payloads: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { payload: { picker: unknown } }) => {
    if (cmd === "plugin:native-chrome|set_cwd_picker") ipc.payloads.push(args.payload.picker);
    return Promise.resolve();
  },
  addPluginListener: (_plugin: string, event: string, cb: (event: unknown) => void) => {
    ipc.handlers.set(event, cb);
    return Promise.resolve({ unregister: () => Promise.resolve(ipc.handlers.delete(event)) });
  },
}));
const relay = vi.hoisted(() => ({ listDirectories: vi.fn() }));
vi.mock("@/lib/relay/fsBrowse", () => relay);

import { NativeCwdPicker } from "./NativeCwdPicker";

const profile: Profile = { id: "p1", label: "Personal", host: "localhost", relayPort: 4317 };
const HOME = "/home/wil";
const CWD = "/home/wil/anywh";

/** A fake relay machine: the folders it has, and the ones it can't read. */
const tree: Record<string, string[]> = {
  [HOME]: ["anywh", "personal"],
  [CWD]: ["anywh", "anywh-ios"],
  "/srv": ["data"],
};
const forbidden = new Set(["/root"]);

function list(path: string | undefined): Promise<FsListResult> {
  const target = path ?? HOME;
  if (forbidden.has(target)) return Promise.reject(new Error("permission_denied"));
  const names = tree[target];
  if (!names) return Promise.reject(new Error("not_found"));
  return Promise.resolve({ path: target, entries: names.map((name) => ({ name, path: `${target}/${name}` })) });
}

function lastPayload(): NativeCwdPickerPayload | null {
  return ipc.payloads[ipc.payloads.length - 1] as NativeCwdPickerPayload | null;
}

type Props = Partial<Parameters<typeof NativeCwdPicker>[0]>;

async function mount(props: Props = {}) {
  const onSetCwd = vi.fn();
  const onPicked = vi.fn();
  const all = { profile, sessionId: "s1", cwd: CWD, locked: false, connected: true, isNewConversation: true, home: HOME, onSetCwd, onPicked, ...props };
  const view = render(<NativeCwdPicker {...all} />);
  await waitFor(() => expect(ipc.handlers.has("cwdPickerChoose")).toBe(true));
  const rerender = (next: Props) => view.rerender(<NativeCwdPicker {...all} {...next} />);
  return { onSetCwd, onPicked, view, rerender };
}

function fire(event: string, data: Record<string, unknown>) {
  act(() => ipc.handlers.get(event)!(data));
}

/** What native sends when the capsule is tapped: the sheet opens on the
 * conversation's folder. */
function open(key = "s1") {
  fire("cwdPickerOpen", { key });
  fire("cwdPickerFolder", { key, path: CWD });
}

beforeEach(() => {
  localStorage.clear();
  relay.listDirectories.mockImplementation((_profile: Profile, path?: string) => list(path));
});

afterEach(() => {
  cleanup();
  ipc.handlers.clear();
  ipc.payloads.length = 0;
  relay.listDirectories.mockReset();
});

describe("NativeCwdPicker", () => {
  it("sends the capsule while the folder can be chosen, and takes it away when fixed or unmounted", async () => {
    const { rerender, view } = await mount();
    await waitFor(() => expect(lastPayload()?.capsule.name).toBe("anywh"));
    rerender({ locked: true });
    await waitFor(() => expect(lastPayload()).toBeNull());
    rerender({ locked: false });
    await waitFor(() => expect(lastPayload()?.key).toBe("s1"));
    view.unmount();
    expect(lastPayload()).toBeNull();
  });

  it("offers a new conversation's folder before connecting, an existing one's only once connected", async () => {
    const { rerender } = await mount({ connected: false });
    await waitFor(() => expect(lastPayload()?.key).toBe("s1"));
    rerender({ isNewConversation: false });
    await waitFor(() => expect(lastPayload()).toBeNull());
    rerender({ isNewConversation: false, connected: true });
    await waitFor(() => expect(lastPayload()?.key).toBe("s1"));
  });

  it("lists the folder the sheet opens on, hidden ones included, and shows paths from the home folder", async () => {
    await mount();
    open();
    await waitFor(() => expect(lastPayload()?.folders[CWD]?.status).toBe("ready"));
    expect(relay.listDirectories).toHaveBeenCalledWith(profile, CWD, true);
    expect(lastPayload()?.folders[CWD].entries.map((entry) => entry.name)).toEqual(["anywh", "anywh-ios"]);
    expect(lastPayload()?.home?.display).toBe("~");
    expect(lastPayload()?.current.display).toBe("~/anywh");
  });

  it("lists each folder once per opening, and starts over on the next one", async () => {
    await mount();
    open();
    await waitFor(() => expect(lastPayload()?.folders[CWD]?.status).toBe("ready"));
    fire("cwdPickerFolder", { key: "s1", path: CWD });
    expect(relay.listDirectories.mock.calls.filter(([, path]) => path === CWD)).toHaveLength(1);
    fire("cwdPickerClose", { key: "s1" });
    await waitFor(() => expect(lastPayload()?.folders).toEqual({}));
    open();
    await waitFor(() => expect(relay.listDirectories.mock.calls.filter(([, path]) => path === CWD)).toHaveLength(2));
  });

  it("drops a listing that answers after the sheet closed", async () => {
    let answer: (result: FsListResult) => void = () => {};
    relay.listDirectories.mockImplementation((_profile: Profile, path?: string) =>
      path === "/srv" ? new Promise<FsListResult>((resolve) => (answer = resolve)) : list(path),
    );
    await mount();
    open();
    fire("cwdPickerFolder", { key: "s1", path: "/srv" });
    await waitFor(() => expect(lastPayload()?.folders["/srv"]?.status).toBe("loading"));
    fire("cwdPickerClose", { key: "s1" });
    await act(async () => {
      answer({ path: "/srv", entries: [{ name: "data", path: "/srv/data" }] });
      await Promise.resolve();
    });
    expect(lastPayload()?.folders["/srv"]).toBeUndefined();
  });

  it("keeps a folder the relay couldn't read until Try again", async () => {
    await mount();
    open();
    fire("cwdPickerFolder", { key: "s1", path: "/root" });
    await waitFor(() => expect(lastPayload()?.folders["/root"]?.status).toBe("error"));
    expect(lastPayload()?.folders["/root"].error?.message).toBe("The relay has no permission to list what's in it.");
    fire("cwdPickerFolder", { key: "s1", path: "/root" });
    expect(relay.listDirectories.mock.calls.filter(([, path]) => path === "/root")).toHaveLength(1);
    forbidden.delete("/root");
    tree["/root"] = [];
    fire("cwdPickerRetry", { key: "s1", path: "/root" });
    await waitFor(() => expect(lastPayload()?.folders["/root"]?.status).toBe("ready"));
    forbidden.add("/root");
    delete tree["/root"];
  });

  it("looks a typed path up once it rests, ~ included, and answers only the latest text", async () => {
    await mount();
    open();
    fire("cwdPickerLookup", { key: "s1", query: "/sr" });
    fire("cwdPickerLookup", { key: "s1", query: "/srv" });
    expect(lastPayload()?.lookup).toMatchObject({ query: "/srv", status: "checking" });
    await waitFor(() => expect(lastPayload()?.lookup?.status).toBe("found"));
    expect(relay.listDirectories.mock.calls.some(([, path]) => path === "/sr")).toBe(false);
    expect(lastPayload()?.lookup?.target?.chain.map((folder) => folder.path)).toEqual(["/", "/srv"]);
    // Found, so going there shows it right away.
    expect(lastPayload()?.folders["/srv"]?.status).toBe("ready");

    fire("cwdPickerLookup", { key: "s1", query: "~/personal" });
    await waitFor(() => expect(lastPayload()?.lookup?.status).toBe("missing"));
    expect(relay.listDirectories).toHaveBeenCalledWith(profile, "/home/wil/personal", true);
    expect(lastPayload()?.lookup?.error).toEqual({ title: "Folder not found", message: "Nothing at ~/personal on the relay's machine. Check the path." });
  });

  it("can't follow ~ while the home folder is unknown", async () => {
    await mount({ home: null });
    open();
    fire("cwdPickerLookup", { key: "s1", query: "~/anywh" });
    await waitFor(() => expect(lastPayload()?.lookup?.status).toBe("missing"));
    expect(lastPayload()?.lookup?.error?.message).toBe("The relay didn't answer. Check the connection and try again.");
  });

  it("sets a picked folder once, remembers it and hands the focus back", async () => {
    const { onSetCwd, onPicked } = await mount();
    open();
    fire("cwdPickerChoose", { key: "s1", path: "/srv" });
    // The second tap of a double tap on "Use this folder".
    fire("cwdPickerChoose", { key: "s1", path: "/srv" });
    expect(onSetCwd).toHaveBeenCalledTimes(1);
    expect(onSetCwd).toHaveBeenCalledWith("/srv");
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("anywh:recent-folders:p1") ?? "[]")).toEqual(["/srv"]);
  });

  it("flashes the capsule when the picked folder takes effect", async () => {
    const { rerender } = await mount();
    open();
    fire("cwdPickerChoose", { key: "s1", path: "/srv" });
    expect(lastPayload()?.flash).toBe(0);
    rerender({ cwd: "/srv" });
    await waitFor(() => expect(lastPayload()?.flash).toBe(1));
    expect(lastPayload()?.capsule.name).toBe("srv");
  });

  it("ignores what another conversation's sheet reports, and a pick once the folder is fixed", async () => {
    const { onSetCwd, rerender } = await mount();
    open("s0");
    fire("cwdPickerChoose", { key: "s0", path: "/srv" });
    expect(relay.listDirectories).not.toHaveBeenCalled();
    expect(onSetCwd).not.toHaveBeenCalled();
    open();
    rerender({ locked: true });
    fire("cwdPickerChoose", { key: "s1", path: "/srv" });
    expect(onSetCwd).not.toHaveBeenCalled();
  });
});
