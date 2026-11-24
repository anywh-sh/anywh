/**
 * An uncaught error as the one thing about it that may leave the app: its
 * type and where in the app's own code it was thrown. Never its message
 * (that is where a path, a prompt or a host name would be), never a frame
 * from outside the app's bundle (an extension, a page the webview loaded),
 * never a variable.
 *
 * The event is built here rather than by the SDK's own exception capture,
 * so the shape that leaves is this file's and its tests', not whatever the
 * SDK version adds.
 */

export interface ExceptionFrame {
  platform: "web:javascript";
  filename: string;
  function: string;
  lineno: number;
  colno: number;
  in_app: true;
  /** Which uploaded source map resolves this file (set by the release
   * build's `posthog-cli sourcemap inject`). */
  chunk_id?: string;
}

export interface ExceptionReport {
  /** Same type at the same place: one report per session. */
  fingerprint: string;
  properties: {
    $exception_list: {
      type: string;
      value: "";
      mechanism: { type: "generic"; handled: boolean; synthetic: false };
      stacktrace: { type: "raw"; frames: ExceptionFrame[] };
    }[];
    $exception_level: "error";
  };
}

const MAX_FRAMES = 30;
const IDENTIFIER = /^[A-Za-z_$][\w$.<>]{0,80}$/;
const ERROR_TYPE = /^[A-Za-z_$][\w$]{0,60}$/;

interface RawFrame {
  fn: string;
  url: string;
  line: number;
  col: number;
}

/** One line of a V8 (`at fn (url:1:2)`, `at url:1:2`) or a WebKit/Gecko
 * (`fn@url:1:2`) stack. */
function parseLine(line: string): RawFrame | null {
  const v8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
  if (v8) return { fn: v8[1] ?? "", url: v8[2], line: Number(v8[3]), col: Number(v8[4]) };
  const webkit = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
  if (webkit) return { fn: webkit[1], url: webkit[2], line: Number(webkit[3]), col: Number(webkit[4]) };
  return null;
}

/** Innermost frame first, as the stack prints it. */
export function parseStack(stack: string | undefined): RawFrame[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map(parseLine)
    .filter((frame): frame is RawFrame => frame !== null);
}

/** File URL → chunk id, from the map the release build injects: each key
 * is a stack captured inside that file. */
export function chunkIdsByFile(chunkIds: Record<string, string> | undefined): Map<string, string> {
  const byFile = new Map<string, string>();
  if (!chunkIds) return byFile;
  for (const [stack, id] of Object.entries(chunkIds)) {
    const frame = parseStack(stack)[0];
    if (frame) byFile.set(frame.url, id);
  }
  return byFile;
}

function inApp(url: string, appOrigin: string): boolean {
  return appOrigin !== "" && (url === appOrigin || url.startsWith(`${appOrigin}/`));
}

/** The report for `error`, or null when nothing about it is the app's (no
 * frame in its bundle): there would be nothing to fix in this codebase. */
export function exceptionReport(
  error: unknown,
  options: { handled: boolean; appOrigin: string; chunkIds?: Record<string, string> },
): ExceptionReport | null {
  const isError = error instanceof Error;
  const name = isError ? error.name : "";
  const type = isError ? (ERROR_TYPE.test(name) ? name : "Error") : "NonErrorThrown";
  const chunks = chunkIdsByFile(options.chunkIds);
  const frames = parseStack(isError ? error.stack : undefined)
    .filter((frame) => inApp(frame.url, options.appOrigin))
    .slice(0, MAX_FRAMES)
    .map((frame): ExceptionFrame => {
      const chunk = chunks.get(frame.url);
      return {
        platform: "web:javascript",
        filename: frame.url,
        function: IDENTIFIER.test(frame.fn) ? frame.fn : "?",
        lineno: frame.line,
        colno: frame.col,
        in_app: true,
        ...(chunk ? { chunk_id: chunk } : {}),
      };
    });
  if (isError && frames.length === 0) return null;
  const top = frames[0];
  return {
    fingerprint: `${type}@${top ? `${top.filename}:${String(top.lineno)}:${String(top.colno)}` : "?"}`,
    properties: {
      $exception_list: [
        {
          type,
          value: "",
          mechanism: { type: "generic", handled: options.handled, synthetic: false },
          // Outermost first, the order the ingestion reads.
          stacktrace: { type: "raw", frames: [...frames].reverse() },
        },
      ],
      $exception_level: "error",
    },
  };
}

const FRAME_KEYS = ["platform", "filename", "function", "lineno", "colno", "in_app", "chunk_id"] as const;

/** The second line of defence, on the way out: whatever `$exception_list`
 * reaches the transport is cut back to the fields `exceptionReport` makes,
 * with the message emptied, so no later change (to this code or the SDK)
 * can widen what leaves. Anything that is not a list of objects is dropped. */
export function sanitizeExceptionList(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const type = typeof entry.type === "string" && ERROR_TYPE.test(entry.type) ? entry.type : "Error";
      const mechanism = typeof entry.mechanism === "object" && entry.mechanism !== null ? (entry.mechanism as Record<string, unknown>) : {};
      const stacktrace = typeof entry.stacktrace === "object" && entry.stacktrace !== null ? (entry.stacktrace as Record<string, unknown>) : {};
      const frames: unknown[] = Array.isArray(stacktrace.frames) ? (stacktrace.frames as unknown[]) : [];
      return {
        type,
        value: "",
        mechanism: { type: "generic", handled: mechanism.handled === true, synthetic: false },
        stacktrace: {
          type: "raw",
          frames: frames
            .filter((frame): frame is Record<string, unknown> => typeof frame === "object" && frame !== null && (frame as Record<string, unknown>).in_app === true)
            .slice(0, MAX_FRAMES)
            .map((frame) => Object.fromEntries(FRAME_KEYS.filter((key) => key in frame).map((key) => [key, frame[key]]))),
        },
      };
    });
}
