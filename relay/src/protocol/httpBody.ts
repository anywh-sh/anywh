/** Every JSON route here took a body of a handful of fields, so a cap never
 * mattered; a theme file is the first body that comes from a file the user
 * picked, which is exactly the case where "accumulate until the client stops
 * sending" is not acceptable. Generous enough that no real theme is near it
 * (mirrors MAX_THEME_BYTES in themeRegistry.ts). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** No body-parsing lib in the project (only the binary upload had a chunk
 * accumulator, `uploads.ts`) — the rename body is small enough (an id + a
 * title) that it doesn't justify pulling in a dependency just for this. */
export function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        // Destroying is what stops the upload; without it the sender keeps
        // streaming into a request nobody is reading anymore.
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

/** Same as `readJsonBody`, but an empty/absent body is valid here (means
 * "use the real $HOME") rather than a 400 — unlike every other route below,
 * `/control/profiles/validate`'s whole body is optional. */
export function readOptionalJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonBody(req)
    .then((value) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}))
    .catch(() => ({}));
}
