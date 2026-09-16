# Extract → Test → Refactor

A commit workflow for getting an existing piece of code to a new location
or a new shape without its behavior changing along the way, and for
telling the two kinds of change — "moved" and "improved" — apart in the
git history instead of blurring them into one diff nobody can `git bisect`
through.

Three stages. Each is its own commit; together they're normally one PR.

## 1. Extract

Move the logic to its own file, **verbatim**. Decisions move; anything
that needs a live process, the filesystem, or the network stays at the
call site and gets passed in as plain data or a function parameter instead
of imported.

Nothing is improved on the way out. If the move genuinely can't be
mechanical — the code being moved mixes two concerns and has to be split
to land in the right place — that's still one commit, but the commit
message says exactly what changed beyond the move and why, so a reviewer
(or a future `git blame`) doesn't have to diff two file locations by hand
to find the one line that isn't a rename.

**Worked example**: `buildChildEnv` lived inside `runtimes/defs/claude/session.ts`
and was imported directly by `host/terminalSession.ts` — a `host/` file
reaching into `runtimes/` for logic, exactly backwards from the folder
split's own rule. The extraction split the function: the host-shaped part
(strip credentials, override `$HOME`, prepend `$PATH`) became
`host/childEnv.ts`, taking the credential-stripping function and the extra
`$PATH` entries as parameters instead of importing them — so the new file
never has to know `runtimes/` exists. The one truly Claude-specific line
became a plain data constant exported from the def instead. The commit
message spells out the split instead of letting the diff imply it was a
pure move.

## 2. Test

Write **characterization** tests: pin down what the code does *today*,
not what it should do. This is deliberately not the same instinct as
writing a test for new code — the goal here is a tripwire for accidental
behavior change during the refactor step, not a spec of correct behavior.

Two habits that make this stage worth doing instead of a formality:

- **Probe the real thing before asserting**, especially for anything that
  touches a live process, a timing window, or an external format. A test
  that asserts what you assumed the code does, rather than what a run
  proved it does, is checking your assumption, not the code.
- **Break the module on purpose once, and confirm the suite goes red.** If
  it doesn't, the tests weren't load-bearing — they were passing regardless
  of the code underneath, which is worse than no test at all because it
  reads as coverage.

**Extraction surfaces bugs. Do not fix them here.** Writing a
characterization test for code that's about to move is exactly when a
latent bug tends to surface, because it's the first time anyone has looked
closely enough to write down what the code actually does. Pin the bug down
with a test and a `// known bug:` comment explaining what's wrong, note it
somewhere separate from the diff (a follow-up item, an issue), and move
on. Fixing it in the same commit as an extraction conflates two unrelated
changes and makes both harder to review.

## 3. Refactor

Only now does anything get to improve. This stage is often small — that's
the expected outcome, not a sign the first two stages did too much of the
work. A large stage 3 is a signal to look back at stage 1: the extraction
likely moved more than it should have, and the diff is hiding a real
change behind a rename.

Skipping stage 3 entirely is a legitimate outcome. Extract and Test already
deliver the value that matters most — a clean move, load-bearing tests —
and "must also improve something" isn't a requirement layered on top.

## For new code, not just extractions

The same discipline applies to a new feature, phrased as a rule instead of
a workflow: **don't create the problem the next extraction would have to
solve.** Write the logic in its own module from the start, with a test
already alongside it, and keep the handler or route it's wired into
reduced to orchestration — calling the module, not containing the
decision. A flat `server.ts` with 25 routes' worth of logic inline didn't
happen in one commit; it happened one "just add it to the handler for now"
at a time.
