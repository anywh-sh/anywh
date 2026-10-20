# Deferred tool approval

An ordinary session answers a tool approval by holding the `claude` process
open on a permission request until a person answers (`permissionBridge.ts`).
A session driven on behalf of another agent can wait for hours, so it does
not: it uses **deferred approval**.

## Behaviour

Off by default. `SharedSessionOptions.deferredApproval` turns it on, and it
defaults to `agentWorker`, so every agent-worker session has it. `SessionManager`
reads both from its `sessionTraits` hook when it creates a session.

1. The CLI asks the permission bridge about a tool call. `SharedSession.checkPermission`
   answers at once with a refusal, `awaiting user approval; end your turn`.
   `McpPermissionBridge.openCalls()` stays at zero: nothing is left open.
2. The call (tool, input, tool-use id, subagent id when known) is staged. When
   the turn ends, everything it staged becomes one pending approval, one
   question per call, persisted in the sessions file as `pendingApproval` with
   the same validation, `askedAt` and restart behaviour as a deferred question.
   The card is published once, with a stable id: it never changes while a
   person is answering it. Refusals are staged per turn, so interrupting one
   turn only drops its own. A call that arrives while that card is on screen
   waits, persisted (`queuedApproval`), and becomes a new card once it is
   answered. Only the fields a grant is
   derived from (`file_path`, `notebook_path`, `command`) are stored whole; any
   other field over 4 KB is cut with a marker.
3. It is published as a `choice_prompt` with `kind: "approval"` and the usual
   `approval: { tool, detail }` question, so an existing client shows and
   answers it unchanged. Only one deferred card is on screen at a time: a
   `present_choice` question and a deferred approval wait for each other
   (both already persisted) rather than hiding one another. A current client
   sends the selection it holds when the card is closed with its X, so closing
   is not a refusal; only an explicit "Deny" is.
4. The answer starts a new turn in the same session, marked synthetic (no
   title, no folder lock, no suggestion). Approved calls that get a permission
   are passed as `TurnContext.grants`; the message tells the model to repeat
   them (`approved: retry the denied call`), says which approved calls will be
   asked about again, and tells it not to retry the refused ones. A human who
   types a message (or edits one) instead of answering dismisses the pending
   approval, and the model is told it was withdrawn; so is the model of a turn
   the person stopped after it had heard "wait for approval" (remembered in
   `withdrawnApproval`, so it survives a restart). That note travels behind an
   `[anywh-note]` marker at the end of the prompt, is not part of the broadcast
   `user_message`, and is stripped when history is rebuilt from the transcript, but only when it is
exactly one of the notes the relay adds; text a person pasted with the marker
in it is left alone. Switching agent does not use the note up: it stays owed to
the next turn of an agent that waited for an approval.
5. A call from a native subagent belongs to the parent session. The permission
   request carries no agent id (measured with CLI 2.1.303), so the subagent is
   recognised from the stream, where its tool calls are announced with the
   id of the `Agent` call that started them. This is best effort, and the card
   names that call id rather than a friendly subagent name.

## What a grant means for Claude

The follow-up turn runs with `--allowedTools` rules from `grantRules.ts`:

| Approved call | Rule | Scope |
| --- | --- | --- |
| Write / Edit / MultiEdit on an absolute, canonical path (no `..`, `.`, `//`, trailing slash, glob characters or symlink in the way) | `Edit(//absolute/path)` | that file |
| Write / Edit / MultiEdit on any other path (`app/[id]/page.tsx`, a symlinked directory such as `/tmp` on macOS, a relative path) | `Write` / `Edit` | every file edit of the turn (broad) |
| Bash with a plain command | `Bash(<exact command>)` | that command |
| Bash with shell operators or rule syntax, MCP tools, WebFetch, notebooks, anything else | the tool name | the whole tool, for that one turn (broad) |
| a call with no path or command at all | none | asked again |

The rule for each call is decided once, when the call is refused, stored with
it in `pendingApproval` and shown on the card; the answer, hours later, uses
the stored rule and may only narrow it (a folder that became a symlink in the
meantime gets "asked again", never something wider).

A broad grant is only given when nothing of that tool is refused **or still
undecided** (a call queued behind this card counts). `Write`, `Edit`,
`MultiEdit` and `NotebookEdit` count as one tool here, and the card says
"every file-edit call". A narrow rule is not given when a refused or waiting
call acts on the same target, compared as a canonical path (relative paths
resolved against the session folder, symlinks resolved when they can be): approving `ls | head` and denying `rm -rf ~/x` grants
`Bash` to neither, and the approved call is asked about again. When a broad
grant is possible the card says so ("approving allows every Bash call during
the next turn"). `Write(/abs)` does not grant in CLI 2.1.303; `Edit(//abs)`
does, and covers Write. An exact `Bash(...)` rule does not grant a command with
an output redirect. Approving `ExitPlanMode` moves the session to `default`
mode.

## Known limits

- A grant is mapped to a rule; if the CLI does not honour the rule the model
  asks again and the person approves again. Not measured: file paths outside
  the session's working directory, notebooks, MCP tools, `WebFetch`.
- A tool-wide grant lasts for the whole follow-up turn, not just the approved
  call.
- The subagent origin depends on the order of the stream line and the
  permission request.
- Each approval costs one extra turn.

## Codex

Not implemented. The shape is ready: `ChoiceMachine` knows nothing about
Claude, `TurnContext.grants` is driver-agnostic, and a driver that ignores
`grants` simply runs the turn. A Codex driver would register the pending
approval from its server request, end the turn with `turn/interrupt`, and
turn the grants into the thread's approval settings for the new `turn/start`.
None of that has been tried.
