/** Just the last folder's name from the path, so the button/list don't get
 * huge — the full path appears in the tooltip and the "Working directory"
 * dropdown. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const lastSegment = trimmed.split("/").pop();
  return lastSegment || "/";
}

export interface Crumb {
  label: string;
  path: string;
}

/** `/home/user/mode/widgets` -> home > user > mode > widgets, each with the path
 * accumulated up to that point. Root becomes a static "/" crumb. */
export function breadcrumbsFor(path: string): Crumb[] {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "/", path: "/" }];
  let acc = "";
  return segments.map((label) => {
    acc += `/${label}`;
    return { label, path: acc };
  });
}

export function parentOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
