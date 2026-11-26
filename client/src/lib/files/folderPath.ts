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

/** Every folder from `/` down to `path`, itself included. */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const chain = ["/"];
  let acc = "";
  for (const segment of segments) {
    acc += `/${segment}`;
    chain.push(acc);
  }
  return chain;
}

/** The relay's own rule for folders it leaves out of a listing unless asked
 * (`isHidden` in relay/src/fs/fsFiles.ts): dot-folders and `node_modules`. */
export function isHiddenFolder(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** `path` with the home folder written `~`, as a shell would show it. */
export function displayPath(path: string, home: string | null): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Text typed into a folder search that reads as a path rather than a name. */
export function isPathQuery(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~");
}

/** A typed path made absolute for the relay, which only takes absolute paths:
 * `~` and `~/…` expand to `home`, trailing slashes go. `null` when it starts
 * with `~` and the home folder isn't known yet. `~user` is left as typed, so
 * the relay refuses it as an invalid path. */
export function resolvePathQuery(text: string, home: string | null): string | null {
  const trimmed = text.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? (home === null ? null : `${home === "/" ? "" : home}${trimmed.slice(1)}`) : trimmed;
  if (expanded === null) return null;
  const withoutTrailing = expanded.replace(/\/+$/, "");
  return withoutTrailing === "" ? "/" : withoutTrailing;
}
