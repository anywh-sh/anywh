import { readFileSync } from "node:fs";
import { resolveShipped } from "../host/paths.js";

/** The release this relay/host build comes from (`package.json`'s version).
 * Both sides ship in the same artifact; the handshake carries it so a refusal
 * can say which two releases met, not just which protocol numbers. */
export const RELEASE_VERSION = (JSON.parse(readFileSync(resolveShipped(import.meta.url, "../../package.json", "package.json"), "utf8")) as { version: string }).version;
