// Checks anywh-bg follow-up turns end to end against a relay that drives the
// REAL `claude` binary (start one with `RELAY_PORT=<free port> npm run dev`
// and pass the same port as RELAY_PORT here; defaults to 8765).
//
// Scenarios:
//   1. job finishes with exit 0       -> a synthetic report turn arrives and
//                                        mentions the unique marker.
//   2. agent stops its own job with   -> NO second turn: the stop leaves a
//      `anywh-bg stop <id>`              marker the relay honours.
//   3. job dies with exit 143 and the -> a one-line report is shown (the
//      conversation says nothing         model has no evidence to stay quiet).
//   4. job exits 1                    -> always reported, and kept in the
//                                        failed-jobs tray.
// The model is not deterministic: scenarios 3 and 4 assert on what the relay
// guarantees (a visible report), not on exact wording.
import WebSocket from "ws";

const PORT = Number(process.env.RELAY_PORT ?? 8765);
const tag = Date.now();

function connect(name) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?session=${name}-${tag}`);
  const events = [];
  const states = [];
  socket.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "agent_event") events.push(m.event);
    else if (m.type === "background_job_state") states.push(m);
  });
  return { socket, events, states, opened: new Promise((r) => socket.on("open", r)) };
}

const turns = (c) => c.events.filter((e) => e.type === "turn_ended").length;
const synthetic = (c) => c.events.filter((e) => e.type === "user_message" && e.synthetic === "background_job");
const texts = (c) => c.events.filter((e) => e.type === "text").map((e) => e.text);

async function waitFor(cond, timeoutMs, what) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function fail(msg) {
  console.error(`[test] FAILED: ${msg}`);
  process.exit(1);
}

async function scenario(name, prompt, check) {
  if (!run(name)) return;
  console.log(`\n[test] --- ${name}`);
  const c = connect(name);
  await c.opened;
  c.socket.send(JSON.stringify({ type: "user_message", text: prompt }));
  await waitFor(() => turns(c) >= 1, 90_000, "first turn");
  console.log("[test] first turn:", texts(c).at(-1));
  await check(c);
  c.socket.close();
}

const only = process.env.ONLY;
const run = (name) => !only || only === name;
const marker = `bg-ok-${tag}`;
await scenario(
  "exit-0",
  `Run via anywh-bg (do not wait): sleep 4 && echo "${marker}". Just confirm it started, one short sentence.`,
  async (c) => {
    await waitFor(() => synthetic(c).length >= 1 && turns(c) >= 2, 60_000, "the report turn");
    if (!texts(c).at(-1)?.includes(marker)) fail(`report does not mention ${marker}: ${texts(c).at(-1)}`);
    console.log("[test] OK report:", texts(c).at(-1));
  },
);

await scenario(
  "agent-stops-own-job",
  "Start `sleep 300` via anywh-bg start, then immediately stop that job with `anywh-bg stop <id>` (use the id from the start output). Then answer in one short sentence.",
  async (c) => {
    // Poll interval is 10s by default; wait comfortably past two polls.
    await new Promise((r) => setTimeout(r, 25_000));
    if (synthetic(c).length > 0 || turns(c) !== 1) fail(`a stopped job produced a report turn (turns=${turns(c)})`);
    console.log("[test] OK no report turn after anywh-bg stop");
  },
);

await scenario(
  "exit-143-no-evidence",
  'Run via anywh-bg (do not wait): sleep 4; kill -TERM $$ . You did not stop it; just confirm it started, one short sentence.',
  async (c) => {
    await waitFor(() => turns(c) >= 2, 60_000, "a report turn");
    console.log("[test] report (may legitimately be NO_REPLY-silenced only with evidence):", texts(c).at(-1));
    if (synthetic(c).length === 0) fail("exit 143 with no evidence of a deliberate stop was fully silenced");
  },
);

await scenario(
  "exit-1",
  'Run via anywh-bg (do not wait): sleep 4; echo boom; exit 1 . Just confirm it started, one short sentence.',
  async (c) => {
    await waitFor(() => turns(c) >= 2 && c.states.at(-1)?.failedJobs?.length >= 1, 60_000, "report turn + failed tray entry");
    if (synthetic(c).length === 0) fail("exit 1 produced no visible report");
    console.log("[test] OK report:", texts(c).at(-1), "| failedJobs:", c.states.at(-1).failedJobs.length);
  },
);

// Informational: the agent ends its own job with a plain `kill` (so exit 143
// reaches the relay). Whether the model answers NO_REPLY is its call; either
// outcome is acceptable, the point is to see which one the real model picks.
await scenario(
  "agent-kills-own-job",
  "Start `sleep 300` via anywh-bg start, then kill it yourself with `kill -TERM -<pid>` using the pid from the start output (not anywh-bg stop). Answer in one short sentence.",
  async (c) => {
    await new Promise((r) => setTimeout(r, 25_000));
    console.log(`[test] INFO report turns: ${synthetic(c).length} (0 means the relay honoured NO_REPLY); texts:`, texts(c));
  },
);

console.log("\n[test] ALL OK");
process.exit(0);
