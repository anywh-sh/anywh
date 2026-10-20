// A deferred approval is written to the sessions file when it is created and
// again whenever the file is rewritten, so what is kept of a tool call has to
// stay small: a `Write` can carry a whole file. Only the fields a grant is
// derived from are kept whole; they are the ones a truncation would break.
const MAX_FIELD_CHARS = 4096;
const KEEP_WHOLE = new Set(["file_path", "notebook_path", "command"]);

/** Copy of a tool call's input with every large field shortened (strings) or
 * replaced by a marker (anything else), except the fields a grant needs. */
export function compactToolInput(input: unknown): unknown {
  if (typeof input === "string") return shorten(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (KEEP_WHOLE.has(key)) out[key] = value;
    else if (typeof value === "string") out[key] = shorten(value);
    else {
      const size = JSON.stringify(value)?.length ?? 0;
      out[key] = size > MAX_FIELD_CHARS ? `[omitted: ${size} characters]` : value;
    }
  }
  return out;
}

function shorten(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…[truncated ${text.length - MAX_FIELD_CHARS} more characters]` : text;
}
