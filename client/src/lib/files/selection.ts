/** Drops every path that sits under another path of the set. Deleting a
 * folder already removes its children, so a selection holding both would
 * otherwise try to delete the child after its parent is gone. */
export function dropNestedPaths(paths: Iterable<string>): string[] {
  const all = Array.from(new Set(paths));
  return all.filter((path) => !all.some((other) => other !== path && path.startsWith(other.endsWith("/") ? other : `${other}/`)));
}
