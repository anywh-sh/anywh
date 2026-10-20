// Persistent stream-json mode of the fake `claude` (loaded by fake-claude.mjs
// for `-p --input-format stream-json` without `--no-session-persistence`):
// one long-lived process, one turn per user message on stdin, the way the
// agent host drives the real CLI. Mirrors what was measured against Claude
// Code 2.1.303:
//   - each user message starts a turn: `system`/`init`, output, one `result`;
//   - a message arriving while a turn is in flight is folded into that turn
//     (the turn still ends with a single `result`, which here names it);
//   - an `interrupt` control request ends the turn with an error `result`
//     (`terminal_reason: "aborted_tools"`) and the process keeps going;
//   - stdin closing with no turn in flight ends the process;
//   - SIGTERM ends the process after cleaning up the processes its tools
//     started (unless FAKE_CLAUDE_IGNORE_SIGTERM is set, to exercise the
//     host's SIGKILL path).
//
// The model's behaviour is scripted by markers in the message text, so a
// test decides what a turn does without any env plumbing:
//   [[gate:<path>]]      emit a tool call and some output, then wait until
//                        <path> exists before finishing the turn — a turn
//                        that is reliably still in flight while the test
//                        does something else (restart the relay, send more)
//   [[events:<n>]]       with a gate: how many output events before waiting
//   [[hang]]             start a tool call and wait for an interrupt
//   [[children:<path>]]  start two real `sleep` processes, one in this
//                        process's group and one in a session of its own
//                        (like the real Bash tool), write their pids to
//                        <path> as JSON, then wait for an interrupt
//   [[bg-task:<path>]]   report a background task and end the turn; the
//                        task is reported finished once <path> exists
//   [[crash]]            exit with code 3 in the middle of the turn
//   [[stale-result:<path>]] end the turn normally; when the NEXT message
//                        arrives, first print one more lone `result` (as if
//                        a background-triggered turn's result were still in
//                        the pipe when the host wrote it), then wait until
//                        <path> exists before starting that message's turn
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

export async function runPersistent(args) {
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const sessionId = flag("--resume") ?? randomUUID();
  const model = flag("--model") ?? "claude-fake-5";
  const partial = args.includes("--include-partial-messages");
  const children = [];
  let turn = null; // { absorbed: string[], interrupt: () => void }
  let inputEnded = false;
  let staleBeforeNext = null; // gate path, see [[stale-result]]
  let turns = 0;

  const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
  const waitForFile = (path) =>
    new Promise((resolve) => {
      const check = () => (existsSync(path) ? resolve() : setTimeout(check, 20));
      check();
    });
  const killChildren = () => {
    for (const child of children) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  };

  process.on("SIGTERM", () => {
    if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM) return;
    killChildren();
    process.exit(143);
  });

  const finish = (text, { error = false, terminal = "completed" } = {}) => {
    const absorbed = turn?.absorbed ?? [];
    const full = absorbed.length > 0 ? `${text} (absorbed: ${absorbed.join(" | ")})` : text;
    if (!error) {
      emit({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model, content: [{ type: "text", text: full }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    }
    emit({
      type: "result",
      subtype: error ? "error_during_execution" : "success",
      is_error: error,
      terminal_reason: terminal,
      result: full,
      num_turns: turns,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
    turn = null;
    if (inputEnded) process.exit(0);
  };

  const toolCall = (id, command) =>
    emit({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });

  const waitForInterrupt = () =>
    new Promise((resolve) => {
      turn.interrupt = resolve;
    });

  async function runTurn(text) {
    turns++;
    turn = { absorbed: [], interrupt: null };
    emit({ type: "system", subtype: "init", model, cwd: process.cwd(), tools: ["Bash"] });
    if (partial) emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "…" } } });

    const stale = /\[\[stale-result:([^\]]+)\]\]/.exec(text)?.[1];
    if (stale) staleBeforeNext = stale;
    if (text.includes("[[crash]]")) {
      process.exit(3);
    }
    const gate = /\[\[gate:([^\]]+)\]\]/.exec(text)?.[1];
    if (gate) {
      const count = Number(/\[\[events:(\d+)\]\]/.exec(text)?.[1] ?? 3);
      toolCall("toolu_gate", "make build");
      for (let i = 0; i < count; i++) {
        emit({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model, content: [{ type: "text", text: `progress ${i + 1}/${count}` }] } });
      }
      await waitForFile(gate);
      emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_gate", content: "built" }] } });
      finish(`done after gate`);
      return;
    }
    const pidFile = /\[\[children:([^\]]+)\]\]/.exec(text)?.[1];
    if (pidFile) {
      toolCall("toolu_children", "sleep 300 & setsid sleep 301");
      // One child in our own group, one that left it (own session), as the
      // real Bash tool does for every command it runs.
      const inGroup = spawn("sleep", ["300"], { stdio: "ignore" });
      const ownSession = spawn("sleep", ["301"], { stdio: "ignore", detached: true });
      children.push(inGroup, ownSession);
      writeFileSync(pidFile, JSON.stringify({ inGroup: inGroup.pid, ownSession: ownSession.pid }));
      await waitForInterrupt();
      killChildren();
      emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_children", content: "interrupted", is_error: true }] } });
      finish("[Request interrupted by user for tool use]", { error: true, terminal: "aborted_tools" });
      return;
    }
    if (text.includes("[[hang]]")) {
      toolCall("toolu_hang", "sleep 1000");
      await waitForInterrupt();
      emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_hang", content: "interrupted", is_error: true }] } });
      finish("[Request interrupted by user for tool use]", { error: true, terminal: "aborted_tools" });
      return;
    }
    const bgGate = /\[\[bg-task:([^\]]+)\]\]/.exec(text)?.[1];
    if (bgGate) {
      emit({ type: "system", subtype: "task_started", task_id: "bg1", description: "background job", is_backgrounded: true, task_type: "local_bash" });
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "background job" }] });
      finish("started in background");
      void waitForFile(bgGate).then(() => {
        emit({ type: "system", subtype: "task_notification", task_id: "bg1", status: "completed", summary: "background job done" });
        emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      });
      return;
    }
    finish(`echo: ${text}`);
  }

  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "control_request") {
        emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
        if (message.request?.subtype === "interrupt") turn?.interrupt?.();
        continue;
      }
      if (message.type !== "user") continue;
      const text = (message.message?.content ?? []).map((block) => block.text ?? "").join("");
      if (turn) {
        turn.absorbed.push(text);
        continue;
      }
      if (staleBeforeNext) {
        const gate = staleBeforeNext;
        staleBeforeNext = null;
        emit({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: "late result of an earlier turn", num_turns: turns });
        turn = { absorbed: [], interrupt: null };
        void waitForFile(gate).then(() => {
          turn = null;
          void runTurn(text);
        });
        continue;
      }
      void runTurn(text);
    }
  });
  process.stdin.on("end", () => {
    inputEnded = true;
    if (!turn) process.exit(0);
  });
  // Keep the process alive while waiting for input, like the real CLI.
  setInterval(() => {}, 60_000);
}
