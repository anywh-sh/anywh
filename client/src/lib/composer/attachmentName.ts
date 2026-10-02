/** Last path segment of an attachment, for the chip that stands in for a
 * thumbnail that couldn't be produced. The relay hands back POSIX paths
 * regardless of the machine it runs on, so splitting on "/" is enough. */
export function attachmentName(path: string, fallback: string): string {
  return path.split("/").filter(Boolean).pop() ?? fallback;
}
