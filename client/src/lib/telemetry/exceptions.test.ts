import { describe, expect, it } from "vitest";
import { exceptionReport, parseStack, sanitizeExceptionList } from "@/lib/telemetry/exceptions";
import { scrubEvent } from "@/lib/telemetry/scrub";

const APP = "tauri://localhost";

function thrown(name: string, message: string, stack: string): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

// A WebView2 (V8) stack and a WKWebView (WebKit) one, both from the bundle.
const V8 = [
  "TypeError: cannot read /Users/someone/proj/secret.ts",
  "    at Kt (tauri://localhost/assets/index-B7x9aQ.js:1:48213)",
  "    at async e (tauri://localhost/assets/index-B7x9aQ.js:1:91877)",
  "    at chrome-extension://abc/inject.js:3:9",
  "    at tauri://localhost/assets/vendor-x1.js:2:10",
].join("\n");
const WEBKIT = ["Kt@tauri://localhost/assets/index-B7x9aQ.js:1:48213", "@tauri://localhost/assets/index-B7x9aQ.js:1:91877", "safari-web-extension://x/a.js:1:1"].join("\n");

describe("an exception report", () => {
  it("is the error's type and its frames in the app's bundle, outermost first, and never the message", () => {
    const report = exceptionReport(thrown("TypeError", "cannot read /Users/someone/proj/secret.ts", V8), { handled: false, appOrigin: APP })!;
    const [entry] = report.properties.$exception_list;
    expect(entry.type).toBe("TypeError");
    expect(entry.value).toBe("");
    expect(entry.mechanism).toEqual({ type: "generic", handled: false, synthetic: false });
    expect(entry.stacktrace.frames.map((frame) => [frame.filename, frame.function, frame.lineno])).toEqual([
      ["tauri://localhost/assets/vendor-x1.js", "?", 2],
      ["tauri://localhost/assets/index-B7x9aQ.js", "?", 1],
      ["tauri://localhost/assets/index-B7x9aQ.js", "Kt", 1],
    ]);
    expect(JSON.stringify(report)).not.toMatch(/someone|secret|extension/);
    expect(report.fingerprint).toBe("TypeError@tauri://localhost/assets/index-B7x9aQ.js:1:48213");
  });

  it("reads a WebKit stack the same way", () => {
    const report = exceptionReport(thrown("Error", "x", WEBKIT), { handled: true, appOrigin: APP })!;
    expect(report.properties.$exception_list[0].stacktrace.frames.map((frame) => frame.function)).toEqual(["?", "Kt"]);
    expect(report.properties.$exception_list[0].mechanism.handled).toBe(true);
  });

  it("names the uploaded source map each bundle file maps to", () => {
    const chunkIds = { ["Error\n    at tauri://localhost/assets/index-B7x9aQ.js:1:1"]: "chunk-1" };
    const report = exceptionReport(thrown("Error", "x", V8), { handled: false, appOrigin: APP, chunkIds })!;
    const frames = report.properties.$exception_list[0].stacktrace.frames;
    expect(frames.filter((frame) => frame.chunk_id === "chunk-1")).toHaveLength(2);
    expect(frames.find((frame) => frame.filename.endsWith("vendor-x1.js"))).not.toHaveProperty("chunk_id");
  });

  it("is nothing for an error with no frame in the app, and a bare type for a thrown non-error", () => {
    expect(exceptionReport(thrown("Error", "x", "@chrome-extension://abc/a.js:1:1"), { handled: false, appOrigin: APP })).toBeNull();
    const odd = exceptionReport("a string with /home/someone", { handled: false, appOrigin: APP })!;
    expect(odd.properties.$exception_list[0]).toMatchObject({ type: "NonErrorThrown", value: "" });
    expect(JSON.stringify(odd)).not.toContain("someone");
  });

  it("does not let a made-up error name through", () => {
    const report = exceptionReport(thrown("Failed at /home/someone", "x", V8), { handled: false, appOrigin: APP })!;
    expect(report.properties.$exception_list[0].type).toBe("Error");
  });

  it("parses what it can and skips the rest", () => {
    expect(parseStack("Error: x\n    at <anonymous>\nnot a frame")).toEqual([]);
  });
});

describe("on the way out", () => {
  it("an exception list is cut back to its fields, with the message emptied and frames outside the app gone", () => {
    const out = scrubEvent({
      event: "$exception",
      properties: {
        $exception_level: "error",
        $exception_message: "cannot read /Users/someone",
        $exception_list: [
          {
            type: "TypeError",
            value: "cannot read /Users/someone",
            extra: "x",
            mechanism: { type: "generic", handled: false, synthetic: false, source: "y" },
            stacktrace: { type: "raw", frames: [{ platform: "web:javascript", filename: "tauri://localhost/a.js", function: "f", lineno: 1, colno: 2, in_app: true, context_line: "secret()" }, { filename: "chrome-extension://x", in_app: false }] },
          },
        ],
      },
    });
    expect(out.properties).not.toHaveProperty("$exception_message");
    expect(out.properties.$exception_level).toBe("error");
    expect(out.properties.$exception_list).toEqual([
      {
        type: "TypeError",
        value: "",
        mechanism: { type: "generic", handled: false, synthetic: false },
        stacktrace: { type: "raw", frames: [{ platform: "web:javascript", filename: "tauri://localhost/a.js", function: "f", lineno: 1, colno: 2, in_app: true }] },
      },
    ]);
    expect(sanitizeExceptionList("nope")).toBeUndefined();
  });
});
