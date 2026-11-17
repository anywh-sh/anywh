import { describe, expect, it } from "vitest";
import { isAbortError, readBodyWithProgress } from "@/lib/relay/fileDownload";

function streamedResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

/** A clock that moves a full report interval per read, so every chunk is
 * reported. */
function steppingClock(): () => number {
  let at = 0;
  return () => (at += 1000);
}

describe("readBodyWithProgress", () => {
  it("returns the whole body and reports the running count against Content-Length", async () => {
    const reports: [number, number][] = [];
    const bytes = await readBodyWithProgress(
      streamedResponse(["abc", "defg", "h"], { "content-length": "8" }),
      999,
      (received, total) => reports.push([received, total]),
      steppingClock(),
    );

    expect(new TextDecoder().decode(bytes)).toBe("abcdefgh");
    expect(reports.slice(0, 3)).toEqual([
      [3, 8],
      [7, 8],
      [8, 8],
    ]);
    expect(reports[reports.length - 1]).toEqual([8, 8]);
  });

  it("falls back to the listed size when the response carries no length", async () => {
    const reports: [number, number][] = [];
    await readBodyWithProgress(streamedResponse(["xy"]), 2, (received, total) => reports.push([received, total]), steppingClock());

    expect(reports[reports.length - 1]).toEqual([2, 2]);
  });

  it("reports at most once per interval, but always the final count", async () => {
    const reports: number[] = [];
    await readBodyWithProgress(
      streamedResponse(["a", "b", "c", "d"], { "content-length": "4" }),
      4,
      (received) => reports.push(received),
      () => 0,
    );

    expect(reports).toEqual([1, 4]);
  });
});

describe("isAbortError", () => {
  it("tells a cancel apart from a failure", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("HTTP 500"))).toBe(false);
  });
});
