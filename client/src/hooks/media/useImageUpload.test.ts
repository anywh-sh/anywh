import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImageUpload } from "@/hooks/media/useImageUpload";
import type { Profile } from "@/lib/profiles/profiles";

const profile: Profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 7777 };

// Only the network edge is faked: each `/upload` waits until the test
// answers it, so the order uploads finish in is the test's to choose.
let answers: ((path: string) => void)[] = [];
let failures: (() => void)[] = [];

beforeEach(() => {
  answers = [];
  failures = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answers.push((path) => resolve(new Response(JSON.stringify({ path }), { status: 200 })));
          failures.push(() => resolve(new Response("boom", { status: 500 })));
        }),
    ),
  );
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const png = (name: string) => new File([new Uint8Array([1])], name, { type: "image/png" });

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useImageUpload", () => {
  it("stays uploading until the last file of overlapping batches lands", async () => {
    const { result } = renderHook(() => useImageUpload(profile, vi.fn()));

    let first!: Promise<File[]>;
    let second!: Promise<File[]>;
    act(() => {
      first = result.current.addFiles([png("a.png")]);
    });
    act(() => {
      second = result.current.addFiles([png("b.png")]);
    });
    await flush();
    expect(result.current.entries.map((entry) => entry.status)).toEqual(["uploading", "uploading"]);

    await act(async () => {
      answers[0]("/up/a.png");
      await first;
    });
    // The first batch finishing must not re-enable send while `b` is in flight.
    expect(result.current.uploading).toBe(true);
    expect(result.current.pending.map((item) => item.path)).toEqual(["/up/a.png"]);

    await act(async () => {
      answers[1]("/up/b.png");
      await second;
    });
    expect(result.current.uploading).toBe(false);
    expect(result.current.pending.map((item) => item.path)).toEqual(["/up/a.png", "/up/b.png"]);
  });

  it("keeps the order files were picked in, not the order they finished in", async () => {
    const { result } = renderHook(() => useImageUpload(profile, vi.fn()));
    let first!: Promise<File[]>;
    let second!: Promise<File[]>;
    act(() => {
      first = result.current.addFiles([png("a.png")]);
      second = result.current.addFiles([png("b.png")]);
    });
    await flush();
    await act(async () => {
      answers[1]("/up/b.png");
      await second;
      answers[0]("/up/a.png");
      await first;
    });
    expect(result.current.pending.map((item) => item.path)).toEqual(["/up/a.png", "/up/b.png"]);
  });

  it("drops a failed file's entry and reports it", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useImageUpload(profile, onError));
    let done!: Promise<File[]>;
    act(() => {
      done = result.current.addFiles([png("a.png")]);
    });
    await flush();
    await act(async () => {
      failures[0]();
      await done;
    });
    expect(result.current.entries).toEqual([]);
    expect(result.current.uploading).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("clearing after a send keeps files still uploading", async () => {
    const { result } = renderHook(() => useImageUpload(profile, vi.fn()));
    let first!: Promise<File[]>;
    act(() => {
      first = result.current.addFiles([png("a.png")]);
    });
    await flush();
    await act(async () => {
      answers[0]("/up/a.png");
      await first;
    });
    act(() => {
      void result.current.addFiles([png("b.png")]);
    });
    await flush();
    act(() => result.current.clearWithoutRevoke());
    expect(result.current.pending).toEqual([]);
    expect(result.current.entries.map((entry) => entry.name)).toEqual(["b.png"]);
  });
});
