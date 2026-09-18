# Contributing to anywh

Thanks for taking the time. This is a small project with a self-hosted threat
model and a couple of conventions that aren't obvious from reading the code —
this file is the short version of everything you need before opening a PR.

## Before you start

- **Bugs and features**: open an issue first for anything non-trivial. A PR that
  changes behaviour without a prior issue may be asked to wait while the design
  gets discussed, and that's a bad outcome for everyone.
- **Small fixes** (typos, broken links, an obviously wrong condition) need no
  issue — just open the PR.
- **Security issues**: do not open an issue. See [SECURITY.md](./SECURITY.md).

## Getting set up

[Self-hosting](./docs/self-hosting.md) covers running the relay and the client
from source. Three things worth repeating here:

- The relay needs an agent CLI installed and logged in on the same machine.
- The client needs the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS — a Rust toolchain plus platform system deps.
- The client also needs a Go toolchain, for a bundled helper binary. Every
  Tauri command builds it first, so there is nothing to run by hand.

The repo is two independent codebases with no shared code:

| Path | What it is |
| --- | --- |
| `relay/` | Node/TypeScript server. Drives whichever agent CLI a session picked (spawned per turn, or a long-lived daemon — see [`relay/src/runtimes/README.md`](./relay/src/runtimes/README.md) for the contract), streams normalized events over WebSocket, persists session state. |
| `client/` | React + TypeScript + Tailwind + shadcn/ui, packaged with Tauri for desktop and iOS. |
| `infra/systemd/` | Optional unit template for running the relay as a service. |

## Language

**Everything that isn't user-facing UI text must be written in English** — code
comments, commit messages, `console.log`/`console.error`, server logs, and any
string that exists only for a developer. This holds regardless of the language
you're working in.

**UI strings go through the dictionary** at `client/src/i18n/`. Anything actually
rendered to a user — JSX text, `placeholder`, `title`, `aria-label`, toasts,
error messages that reach the screen — lives as a key in `dictionary.ts` with
both translations filled in (`en.ts` and `pt-br.ts`). `en` is the default and
the fallback. The `Dictionary` type makes a missing key a compile error, so
there is no "translate it later".

Trace where a string is consumed before deciding which bucket it's in: an error
that bubbles up into a toast is UI, a `console.error` is not.

Parts of the app still have Portuguese hardcoded from before i18n existed.
That's a migration in progress, not licence to add more.

## Tests

Every behaviour change needs a test. The full doctrine — what to test, where
each tier lives, and the one sanctioned exception to "no mocks" — is in
`.anywh/skills/tests/SKILL.md`.

```bash
# relay: unit + integration (integration spawns a real tmux, so you need it installed)
cd relay && npm run test:all

# client: unit + UI integration
cd client && npm test

# client: end-to-end against a real Tauri window (slow — native compile)
cd client && npm run build:e2e && npm run test:e2e
```

CI runs the same three tiers, but only the ones whose paths your PR touched.

## Commits

- **[Conventional Commits](https://www.conventionalcommits.org/)**, with a scope
  where it helps: `feat(client): ...`, `fix(relay): ...`, `docs: ...`.
- **Atomic** — one responsibility per commit. If your working tree accumulated
  two unrelated changes, stage them separately rather than shipping one blob.
- **In English**, title and body, per the Language section above.

## Branches

Branch off `main` and name it `<type>/<short-description>`, reusing the
Conventional Commits type:

```
feat/interactive-file-browser
fix/broker-revoked-terminal-state
chore/english-comments
docs/pairing-protocol
test/e2e-redesign
```

## Pull requests

1. Open the PR against `main`. Fill in the template — "why" matters more than
   "what"; the diff already says what.
2. CI has to be green. The `ci` check is the one that gates merging; it
   aggregates the per-tier jobs, so a failure there means one of them failed.
3. Keep the branch up to date with `main` — the merge button will offer to do
   it for you.
4. Resolve review threads before merging rather than leaving them dangling.
5. PRs are **squash merged**, so the PR title becomes the commit message on
   `main`. Give it a Conventional Commits title.

`main` is protected: no force pushes, no deletions, linear history, and changes
land through PRs.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE), the same licence covering the project.
