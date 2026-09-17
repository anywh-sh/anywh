import type { HostPlatform } from "./types.js";

const KNOWN: readonly HostPlatform[] = ["darwin", "freebsd", "linux", "openbsd", "sunos", "win32"];

/** `NodeJS.Platform`'s eleven values narrowed to the six a def reasons about
 * (`types.ts`'s `HostPlatform`). An unlisted one (`aix`, `android`, ...) reads
 * as `"linux"`: every def's `modesFor` treats `win32` as the special case and
 * everything else as POSIX, so the closest honest answer is the POSIX one. */
export function toHostPlatform(platform: NodeJS.Platform = process.platform): HostPlatform {
  return (KNOWN as readonly string[]).includes(platform) ? (platform as HostPlatform) : "linux";
}
