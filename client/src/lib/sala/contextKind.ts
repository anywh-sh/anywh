import type { RoomContextItem } from "@/lib/relay/roomClient";

/**
 * The short tag drawn in the chip before a shared-context item (`MD`, `PDF`,
 * `IMG`): what the file is, in at most four capitals. The relay only sorts a
 * file into `text`, `pdf`, `image` or `binary`, so the tag leans on the
 * extension for the rest, and falls back to the kind itself when a name has
 * none (or one that is not a plain word).
 */
export function contextKindLabel(item: Pick<RoomContextItem, "name" | "kind">): string {
  if (item.kind === "pdf") return "PDF";
  if (item.kind === "image") return "IMG";
  const dot = item.name.lastIndexOf(".");
  const extension = dot > 0 ? item.name.slice(dot + 1) : "";
  if (/^[A-Za-z0-9]{1,4}$/.test(extension)) return extension.toUpperCase();
  return item.kind === "binary" ? "BIN" : "TXT";
}
