import { isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { chatMediaUrl, fetchChatMedia } from "@/lib/relay/filesClient";

/** Where a tile or the viewer gets a path's bytes from. Two ways, because
 * the two kinds of profile differ: a direct one hands out a URL the webview
 * loads by itself (native caching and progressive decode, ranges for a
 * video), a tailnet one needs each request to carry a fresh token, which an
 * `<img src>` can't — so its bytes are fetched and handed back as an object
 * URL (see `RawImage` in the file panel for the same split). */
export interface ChatMediaSource {
  /** A URL for `src` as is, when the connection allows one. */
  url(path: string): string | undefined;
  /** Otherwise an object URL of the fetched bytes, shared by every caller
   * asking for the same path; the source owns it and frees it. */
  load(path: string): Promise<string>;
}

/** Object URLs kept per source. A conversation rarely shows more; past it
 * the least recently asked for is freed. */
const MAX_LOADED = 48;

/**
 * The relay's `/files/media`, for one session. `getProfile` is read on every
 * call, not captured: the caller's profile object is replaced on most
 * renders and the connection details (a tailnet endpoint) may change under
 * the same profile. `dispose` frees every object URL it made.
 */
export function createRelayMediaSource(getProfile: () => Profile, sessionId: string): ChatMediaSource & { dispose(): void } {
  const loaded = new Map<string, Promise<string>>();

  function free(entry: Promise<string>): void {
    entry.then(
      (url) => URL.revokeObjectURL(url),
      () => {},
    );
  }

  return {
    url(path) {
      const profile = getProfile();
      return isTailnetProfile(profile) ? undefined : chatMediaUrl(profile, sessionId, path);
    },
    load(path) {
      const hit = loaded.get(path);
      if (hit) {
        // Most recently used goes last, so eviction takes the oldest.
        loaded.delete(path);
        loaded.set(path, hit);
        return hit;
      }
      const entry = fetchChatMedia(getProfile(), sessionId, path)
        .then((response) => response.blob())
        .then((blob) => URL.createObjectURL(blob));
      // A failure isn't kept: the next tile asking tries again.
      entry.catch(() => {
        if (loaded.get(path) === entry) loaded.delete(path);
      });
      loaded.set(path, entry);
      while (loaded.size > MAX_LOADED) {
        const [oldest, stale] = loaded.entries().next().value as [string, Promise<string>];
        loaded.delete(oldest);
        free(stale);
      }
      return entry;
    },
    dispose() {
      for (const entry of loaded.values()) free(entry);
      loaded.clear();
    },
  };
}
