---
name: release
description: How anywh is versioned and released — what a PR may and may not do about versions, when a change is breaking, and how a tag becomes a published release
---

# Versioning and releases

## The rule, in one paragraph

Every merge to `main` is a version. The `Version` workflow tags the merge
commit `vX.Y.Z` on its own; **no PR ever edits a version number**. A tag is
not a release: publishing one is a separate, manual step that only the owner
takes. Git keeps every manifest at the placeholder `0.0.0`, and the release
build stamps the tag's version into them.

## What a PR does

1. **Never touch a version.** `client/package.json`, `client/src-tauri/tauri.conf.json`
   and `relay/package.json` stay at `"version": "0.0.0"` (their lockfiles too).
   `client/src/lib/install/appVersion.test.ts` fails if one changes. There is
   no CHANGELOG file to edit either: release notes are generated from the
   commits.
2. **Title it with Conventional Commits.** PRs are squash merged, so the title
   *is* the commit the version is computed from.
3. **Put `!` after the type when the change is breaking** (`feat(relay)!: ...`,
   `fix!: ...`), and say in the PR body what users or operators must do.
   Breaking means any of:
   - an older client, relay or agent host would misread or refuse the new
     one: `WS_PROTOCOL_VERSION`, `AGENT_HOST_PROTOCOL_VERSION`, `THEME_VERSION`
     or any other `*_VERSION`/`version: N` of a wire or on-disk format;
   - an on-disk migration the previous release can't read back;
   - an existing install needs operator action: a new or changed systemd
     unit, a renamed or removed env var, a removed installer flag, a renamed
     release asset;
   - the embedding surface the official iOS build compiles against changes
     incompatibly: `client_lib::run_with`, its Cargo features
     (`mobile-entry`), the host bridge (`client/src/lib/platform/hostBridge.ts`),
     the `tauri-plugin-native-chrome` commands and permissions.

   UI changes, redesigns and new features are **not** breaking on their own.
4. **The `breaking-change guard` check** (part of the required `ci`) fails
   when the diff touches one of those surfaces and the title has no `!`.
   Either add the `!`, or — after checking that nothing above applies — add
   the `not-breaking` label. Editing the title or the labels re-runs the
   check by itself.

## How the version is computed

On each merge, over the commits since the last `vX.Y.Z` tag
(`node scripts/version.mjs next`):

| Commit | Bump | Example |
|---|---|---|
| `!` after the type, or a `BREAKING CHANGE:` footer | MINOR | 0.2.3 → 0.3.0, 1.4.2 → 1.5.0 |
| anything else (`feat`, `fix`, `refactor`, `chore`, …) | PATCH | 0.2.3 → 0.2.4 |
| manual run of the `Version` workflow (owner only) | MAJOR | 0.9.3 → 1.0.0 |

**A deliberate departure from SemVer:** a breaking change bumps the *second*
number, before and after 1.0, and MAJOR is a milestone the owner sets by hand,
never inferred from a commit. A PATCH can therefore carry a new feature.

Tags are immutable (a ruleset blocks deleting or moving them). A mistake is
fixed by the next merge, never by re-tagging.

## How a tag becomes a release (owner only)

Agents do not publish releases. When the owner asks for one, the step is:

```bash
gh workflow run release.yml -R anywh-sh/anywh -f tag=vX.Y.Z -f channel=stable      # or channel=prerelease
```

- `stable` publishes the tag as GitHub's "Latest" release, which is what the
  in-app updater (`releases/latest/download/latest.json`), `install.sh`, the
  landing page and the Homebrew tap follow; it also bumps the tap. It refuses
  a tag that isn't newer than the current stable release.
- `prerelease` builds and publishes the tag without making it "Latest", so
  none of the above sees it. Running `stable` later on the same tag promotes
  it without rebuilding.
- **Upgrade notes:** a stable release that crosses a minor line (the current
  stable is 0.1.x and the tag is 0.2.x or later) requires
  `docs/upgrade-notes/<X.Y>.md` on `main` for every line crossed, without the
  `<!-- draft -->` marker. Write them in a normal PR, any time before
  promoting; an agent may draft them (keeping the marker) when asked to.
- The release body is the generated changelog (`node scripts/version.mjs notes`),
  preceded by those upgrade notes.
- A build that fails leaves a draft release nobody sees; running the workflow
  again for the same tag drops the draft and rebuilds.

## Versions in protocols, not in the app

`WS_PROTOCOL_VERSION` and `AGENT_HOST_PROTOCOL_VERSION` are integers that
only go up, independent of the app version: relay and client ship from the
same tag, so they are "same or different", never a range. Bumping one is
always a breaking change (rule 3 above), so it always lands in a new MINOR.

## Builds from source

A build no release stamped reports `0.0.0`. The app treats it as "unknown":
no relay-drift warning against a relay run from a checkout, and the in-app
relay installer installs the latest release instead of pinning `v0.0.0`.
To build a specific version by hand, stamp it first and don't commit the
result: `node scripts/version.mjs stamp X.Y.Z`.
