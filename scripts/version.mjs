// The versioning mechanism (the rule itself is .anywh/skills/release/SKILL.md):
// every merge to main gets a `vX.Y.Z` tag computed from its commit message,
// the release build stamps that version into the manifests (which stay at
// the unreleased placeholder in git), and publishing a tag is a separate,
// manual step.
//
// Usage:
//   node scripts/version.mjs plan [--major] [--ref <rev>]
//       The tags to create, one `<sha> <tag>` line per untagged commit on
//       the first-parent line from the last version tag up to <rev>
//       (default HEAD), oldest first. Nothing when everything is tagged.
//   node scripts/version.mjs stamp <X.Y.Z>
//       Writes the version into every manifest that carries it.
//   node scripts/version.mjs check <X.Y.Z>
//       Fails unless every manifest carries exactly that version.
//   node scripts/version.mjs notes --tag <vX.Y.Z> [--previous <vA.B.C>] [--require-upgrade-notes]
//       Release notes for a tag: upgrade notes of every minor line it
//       crosses since --previous, then the changelog from the commits.
//   node scripts/version.mjs guard --base <rev> --head <rev> --title <title> [--labels a,b]
//       Fails when the diff touches a surface that can break an existing
//       install and the title isn't marked breaking.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What every manifest says in git: a build from source that no release
 * stamped. The app treats it as "unknown", never as "older than anything". */
export const UNRELEASED_VERSION = "0.0.0";

/** Every file whose `"version"` is the app's. Cargo.toml is not one of them:
 * Tauri stamps the bundle from tauri.conf.json, and Cargo's own field stays
 * frozen (client/src/lib/install/appVersion.test.ts). */
export const VERSIONED_MANIFESTS = ["client/package.json", "client/src-tauri/tauri.conf.json", "relay/package.json"];

export const NOT_BREAKING_LABEL = "not-breaking";

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** `[major, minor, patch]` for a release tag (`v` + three integers, no
 * suffix), `null` for anything else — `v0.1.8-rc.1` is a leftover of the old
 * flow and never a base to count from. */
export function parseVersionTag(tag) {
  const match = VERSION_TAG.exec(tag.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function formatVersion(version) {
  return version.join(".");
}

/** The highest release tag among `tags`, by version rather than by date. */
export function latestVersionTag(tags) {
  let best = null;
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag, version };
  }
  return best;
}

const BREAKING_SUBJECT = /^[a-z]+(\([^)]*\))?!:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/** Conventional Commits: `type!:`/`type(scope)!:` in the subject, or a
 * `BREAKING CHANGE:` footer anywhere in the body. */
export function isBreaking(message) {
  const subject = message.split("\n", 1)[0].trim();
  return BREAKING_SUBJECT.test(subject) || BREAKING_FOOTER.test(message);
}

/** MAJOR only when asked for (a manual milestone, never inferred); MINOR
 * when any commit since `current` is breaking; PATCH otherwise. */
export function nextVersion(current, messages, { major = false } = {}) {
  const [x, y, z] = current ?? [0, 0, 0];
  if (major) return [x + 1, 0, 0];
  if (messages.some(isBreaking)) return [x, y + 1, 0];
  return [x, y, z + 1];
}

/** One version per commit, in order, each bumped from the one before by
 * its own messages — so every merge keeps its own tag even when several are
 * tagged by one run. `commits` are `{ sha, messages }`, oldest first, all
 * after `latest`; a commit carries more than one message only when earlier
 * ones were folded into it (commandPlan). `major` puts a MAJOR on `head`:
 * replacing that commit's own bump when it is in the list, as an extra tag
 * on it otherwise. */
export function planTags(commits, latest, { major = false, head } = {}) {
  const plan = [];
  let version = latest;
  for (const { sha, messages } of commits) {
    version = nextVersion(version, messages);
    plan.push({ sha, version });
  }
  if (major) {
    if (plan.at(-1)?.sha === head) plan.pop();
    const base = plan.at(-1)?.version ?? latest;
    plan.push({ sha: head, version: nextVersion(base, [], { major: true }) });
  }
  return plan.map(({ sha, version: v }) => ({ sha, tag: `v${formatVersion(v)}` }));
}

/** Merges from before this tool existed (a commit whose tree has no
 * scripts/version.mjs) never get a tag of their own: their messages fold
 * into the first commit that has it. Without this, the first run after the
 * tool landed would tag every merge since v0.1.8 one PATCH apart. */
export function foldUntooled(commits) {
  const folded = [];
  let pending = [];
  for (const { sha, message, tooled } of commits) {
    pending.push(message);
    if (!tooled) continue;
    folded.push({ sha, messages: pending });
    pending = [];
  }
  return folded;
}

/** The minor lines a release from `previous` to `target` crosses, as the
 * `X.Y` of every existing `X.Y.0` tag in (previous, target]. Read from the
 * tags rather than counted, since a MAJOR resets the minor number. */
export function crossedMinors(tags, previous, target) {
  const lines = [];
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (!version || version[2] !== 0) continue;
    if (previous && compareVersions(version, previous) <= 0) continue;
    if (compareVersions(version, target) > 0) continue;
    lines.push(version);
  }
  return lines.sort(compareVersions).map(([x, y]) => `${x}.${y}`);
}

const DRAFT_MARKER = "<!-- draft -->";

export function upgradeNotesPath(line) {
  return join("docs", "upgrade-notes", `${line}.md`);
}

/** `{ body }`, or `{ problem }` when the notes are missing or still marked
 * as a draft nobody has reviewed. */
export function readUpgradeNotes(line, readFile) {
  const path = upgradeNotesPath(line);
  const text = readFile(path);
  if (text === null) return { problem: `${path} is missing` };
  if (text.includes(DRAFT_MARKER)) return { problem: `${path} is still marked ${DRAFT_MARKER} — review it and remove the marker` };
  return { body: text.trim() };
}

const SECTIONS = [
  ["Breaking changes", (message) => isBreaking(message)],
  ["Features", (message) => /^feat(\(|:)/.test(message)],
  ["Fixes", (message) => /^(fix|perf)(\(|:)/.test(message)],
  ["Other changes", () => true],
];

/** `entries` are `{ version, message }`, one per commit. Each commit lands in
 * the first section it matches, so a breaking feature is listed once. */
export function renderChangelog(entries) {
  const buckets = SECTIONS.map(([title]) => ({ title, lines: [] }));
  for (const { version, message } of entries) {
    const index = SECTIONS.findIndex(([, matches]) => matches(message));
    const subject = message.split("\n", 1)[0].trim();
    buckets[index].lines.push(`- ${subject} (v${version})`);
  }
  return buckets
    .filter((bucket) => bucket.lines.length > 0)
    .map((bucket) => `### ${bucket.title}\n\n${bucket.lines.join("\n")}`)
    .join("\n\n");
}

/** Splits `git diff --unified=0` into `{ path, lines }`, where `lines` are
 * the added and removed lines without their `+`/`-`. A `---`/`+++` line is a
 * file header only before the file's first `@@`: inside a hunk it is content
 * (a removed `-- comment`, an added YAML `---`) and must not be dropped. */
export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) current.lines.push(line.slice(1));
  }
  return files;
}

const isTestPath = (path) => /(\.test\.|\/tests?\/|\/fixtures\/)/.test(path);

const SOURCE_PATH = /^(relay\/src|client\/src|client\/src-tauri\/src)\//;

// Each rule: which file, which changed lines (if not all of them), and what
// to tell the author. Heuristics on purpose: a false positive costs a label,
// a false negative ships a break to installs that can't see it coming.
const SURFACES = [
  {
    reason: "installer or systemd unit (an existing install may need operator action)",
    path: (p) => p === "install.sh" || p === "install-relay.sh" || (p.startsWith("infra/systemd/") && !p.endsWith(".md")),
  },
  {
    reason: "protocol or schema version constant (an older client, relay or host stops understanding this one)",
    path: (p) => SOURCE_PATH.test(p) && !isTestPath(p),
    line: (l) => /\b[A-Z][A-Z0-9_]*_VERSION\s*=\s*\d+/.test(l),
  },
  {
    reason: "on-disk format version (what an older release reads back)",
    path: (p) => SOURCE_PATH.test(p) && !isTestPath(p),
    line: (l) => /\bversion\s*:\s*\d+\b/.test(l),
  },
  {
    reason: "on-disk migration (a migrated file may not be readable by the previous release)",
    path: (p) => p.startsWith("relay/src/") && !isTestPath(p),
    line: (l) => /migrat/i.test(l),
  },
  {
    reason: "embedding surface: host bridge (the official iOS build calls this)",
    path: (p) => p === "client/src/lib/platform/hostBridge.ts",
  },
  {
    reason: "embedding surface: push address provider exported to the host",
    path: (p) => p === "client/src/lib/platform/pushAddress.ts",
    line: (l) => /^\s*export\b/.test(l),
  },
  {
    reason: "embedding surface: public items of the client crate (run_with)",
    path: (p) => p === "client/src-tauri/src/lib.rs",
    line: (l) => /^\s*pub\s/.test(l),
  },
  {
    reason: "embedding surface: the client crate's features (mobile-entry)",
    path: (p) => p === "client/src-tauri/Cargo.toml",
    line: (l) => /mobile-entry|^\s*default\s*=/.test(l),
  },
  {
    reason: "embedding surface: native-chrome plugin commands or permissions",
    path: (p) => /^client\/src-tauri\/plugins\/tauri-plugin-native-chrome\/(src|permissions)\//.test(p) && !p.includes("/autogenerated/"),
  },
];

export function findBreakingSurfaces(files) {
  const hits = [];
  for (const file of files) {
    for (const surface of SURFACES) {
      if (!surface.path(file.path)) continue;
      if (surface.line && !file.lines.some(surface.line)) continue;
      hits.push({ path: file.path, reason: surface.reason });
    }
  }
  return hits;
}

export function guardVerdict({ surfaces, title, labels }) {
  if (surfaces.length === 0) return { ok: true, message: "No breaking-sensitive surface touched." };
  const list = surfaces.map((hit) => `  - ${hit.path}: ${hit.reason}`).join("\n");
  if (isBreaking(title)) return { ok: true, message: `Marked breaking by the title; touched:\n${list}` };
  if (labels.includes(NOT_BREAKING_LABEL)) {
    return { ok: true, message: `Label "${NOT_BREAKING_LABEL}" says none of these break an existing install:\n${list}` };
  }
  return {
    ok: false,
    message: [
      "This PR touches a surface where an existing install or an older peer can break:",
      list,
      "",
      "Pick one:",
      '  - It IS breaking: put "!" after the type in the PR title (e.g. "feat(relay)!: ...") and say in the PR',
      "    body what users or operators must do. Merging bumps MINOR, and promoting that release requires",
      "    upgrade notes in docs/upgrade-notes/<X.Y>.md.",
      `  - It is NOT breaking (no older client/relay/host misreads anything, no operator action, no one-way`,
      `    migration): add the label "${NOT_BREAKING_LABEL}".`,
      "Changing the title or the labels re-runs this check on its own once the PR's run has finished",
      "(pr-guard-rerun.yml); if it doesn't, run: gh run rerun <run-id> --failed — it reads them again.",
    ].join("\n"),
  };
}

// --- I/O below: git, the filesystem, argv ---------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listTags() {
  return git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
}

/** Full commit messages in `range`, oldest first. */
function commitMessages(range) {
  return git(["log", "--reverse", "--format=%B%x1e", range])
    .split("\x1e")
    .map((message) => message.trim())
    .filter(Boolean);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function commandPlan(args) {
  const ref = option(args, "--ref") ?? "HEAD";
  const major = args.includes("--major");
  const latest = latestVersionTag(listTags());
  const range = latest ? `${latest.tag}..${ref}` : ref;
  const commits = git(["rev-list", "--first-parent", "--reverse", range])
    .split("\n")
    .filter(Boolean)
    .map((sha) => ({
      sha,
      message: git(["log", "-1", "--format=%B", sha]).trim(),
      tooled: git(["ls-tree", "--name-only", sha, "scripts/version.mjs"]).trim() !== "",
    }));
  const head = git(["rev-parse", ref]).trim();
  for (const { sha, tag } of planTags(foldUntooled(commits), latest?.version ?? null, { major, head })) console.log(`${sha} ${tag}`);
}

const VERSION_FIELD = /^(\s*"version":\s*")[^"]*(")/m;

function readManifestVersion(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")).version;
}

function commandStamp(args) {
  const version = args[0];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail(`Usage: node scripts/version.mjs stamp <X.Y.Z>\nGot: ${version ?? "(nothing)"}`);
  // Every target is checked before any is written, so a miss can't leave
  // the tree half-stamped.
  const edits = VERSIONED_MANIFESTS.map((relativePath) => {
    const before = readFileSync(join(root, relativePath), "utf8");
    if (!VERSION_FIELD.test(before)) fail(`${relativePath}: no "version" field, refusing to write anything`);
    return { relativePath, after: before.replace(VERSION_FIELD, `$1${version}$2`) };
  });
  for (const { relativePath, after } of edits) {
    writeFileSync(join(root, relativePath), after);
    console.log(`stamped ${relativePath} with ${version}`);
  }
}

function commandCheck(args) {
  const version = args[0];
  if (!version) fail("Usage: node scripts/version.mjs check <X.Y.Z>");
  const wrong = VERSIONED_MANIFESTS.map((path) => [path, readManifestVersion(path)]).filter(([, found]) => found !== version);
  if (wrong.length > 0) fail(wrong.map(([path, found]) => `${path} carries ${found}, expected ${version}`).join("\n"));
  console.log(`every manifest carries ${version}`);
}

function commandNotes(args) {
  const tag = option(args, "--tag");
  const previousTag = option(args, "--previous");
  const target = tag && parseVersionTag(tag);
  if (!target) fail("Usage: node scripts/version.mjs notes --tag <vX.Y.Z> [--previous <vA.B.C>] [--require-upgrade-notes]");
  const previous = previousTag ? parseVersionTag(previousTag) : null;
  if (previousTag && !previous) fail(`--previous ${previousTag} is not a vX.Y.Z tag`);

  const tags = listTags();
  const parts = [];

  const readFile = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null);
  const problems = [];
  const notes = [];
  for (const line of crossedMinors(tags, previous, target)) {
    const result = readUpgradeNotes(line, readFile);
    if (result.problem) problems.push(result.problem);
    else notes.push(`### ${line}\n\n${result.body}`);
  }
  if (problems.length > 0 && args.includes("--require-upgrade-notes")) {
    fail(`Upgrade notes are required for every minor line ${tag} crosses:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  if (notes.length > 0) parts.push(`## Upgrade notes\n\n${notes.join("\n\n")}`);

  // One changelog entry per commit, credited to the first tag that contains
  // it — normally its own, since every merge is tagged.
  const versions = tags
    .map((name) => ({ name, version: parseVersionTag(name) }))
    .filter(({ version }) => version && compareVersions(version, target) <= 0 && (!previous || compareVersions(version, previous) > 0))
    .sort((a, b) => compareVersions(a.version, b.version));
  const entries = [];
  let from = previousTag;
  for (const { name, version } of versions) {
    for (const message of commitMessages(from ? `${from}..${name}` : name)) entries.push({ version: formatVersion(version), message });
    from = name;
  }
  const changelog = renderChangelog(entries);
  parts.push(`## Changes${previousTag ? ` since ${previousTag}` : ""}\n\n${changelog || "_No changes._"}`);
  console.log(parts.join("\n\n"));
}

function commandGuard(args) {
  const base = option(args, "--base");
  const head = option(args, "--head");
  const title = option(args, "--title");
  if (!base || !head || title === undefined) fail("Usage: node scripts/version.mjs guard --base <rev> --head <rev> --title <title> [--labels a,b]");
  const labels = (option(args, "--labels") ?? "").split(",").map((label) => label.trim()).filter(Boolean);
  const files = parseUnifiedDiff(git(["diff", "--unified=0", `${base}...${head}`]));
  const verdict = guardVerdict({ surfaces: findBreakingSurfaces(files), title, labels });
  if (!verdict.ok) fail(verdict.message);
  console.log(verdict.message);
}

const COMMANDS = { plan: commandPlan, stamp: commandStamp, check: commandCheck, notes: commandNotes, guard: commandGuard };

// pathToFileURL, not a `file://` template: on the Windows build leg argv[1]
// is `D:\a\...`, which a template never matches, and the stamp would
// silently not run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) fail(`Usage: node scripts/version.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
  run(args);
}
