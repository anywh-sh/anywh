/** Name of an attachment, for the chip that stands in for a thumbnail that
 * couldn't be produced: the name the file had on the user's side when known,
 * else the last segment of the relay path. The relay hands back POSIX paths
 * regardless of the machine it runs on, so splitting on "/" is enough. */
export function attachmentName(attachment: { path: string; name?: string }, fallback: string): string {
  return attachment.name ?? attachment.path.split("/").filter(Boolean).pop() ?? fallback;
}
