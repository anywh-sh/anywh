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
2. The call (tool, input, tool-use id, subagent id when known) is kept by
   `ChoiceMachine` as a pending approval and persisted in the sessions file as
   `pendingApproval`, with the same validation, `askedAt` and restart behaviour
   as a deferred question. Several calls of one turn share one prompt, one
   question per call.
3. It is published as a `choice_prompt` with `kind: "approval"` and the usual
   `approval: { tool, detail }` question, so an existing client shows and
   answers it unchanged. Closing the card answers "deny".
4. The answer starts a new turn in the same session. Approved calls are passed
   as `TurnContext.grants`; the message tells the model to repeat them
   (`approved: retry the denied call`) or, for refusals, not to retry. A
   human who types a message instead of answering dismisses the pending
   approval.
5. A call from a native subagent belongs to the parent session. The permission
   request carries no agent id (measured with CLI 2.1.303), so the subagent is
   recognised from the stream, where its tool calls are announced with the
   id of the `Agent` call that started it. This is best effort.

## What a grant means for Claude

The follow-up turn runs with `--allowedTools` rules built by `buildGrantRules`:

| Approved call | Rule | Scope |
| --- | --- | --- |
| Write / Edit / MultiEdit on an absolute path | `Edit(//absolute/path)` | that file |
| Bash with a plain command | `Bash(<exact command>)` | that command |
| anything else (MCP tools, WebFetch, a Bash command with shell operators or rule syntax, a path with wildcards, notebooks) | the tool name | the whole tool, for that one turn |

`Write(/abs)` does not grant in CLI 2.1.303; `Edit(//abs)` does, and covers
Write. An exact `Bash(...)` rule does not grant a command with an output
redirect, so those fall back to the whole tool. Approving `ExitPlanMode`
moves the session to `default` mode.

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
