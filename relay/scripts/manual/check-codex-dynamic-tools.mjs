// Checks the installed `codex` against the protocol shapes the room tools
// rely on for a Codex agent (dynamic tools: `thread/start.dynamicTools`, the
// `item/tool/call` server request, its response, the `dynamicToolCall` item,
// `thread/resume`'s config, `Config.web_search`),
// recorded in tests/fixtures/codex-app-server-0.154.0-dynamic-tools.json.
//
// Only generates the protocol bindings (`codex app-server generate-ts
// --experimental`): no model runs, no quota is spent. Exits 1 when any shape
// drifted, printing what changed; a drift means the Codex room tools must be
// re-checked before trusting them with that version.
//
//   node scripts/manual/check-codex-dynamic-tools.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/codex-app-server-0.154.0-dynamic-tools.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const out = mkdtempSync(join(tmpdir(), "anywh-codex-bindings-"));
try {
  const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", out], { stdio: "ignore" });
  const typeBody = (file, name) => {
    const match = new RegExp(`export type ${name} = ([\\s\\S]*?);\\n`).exec(readFileSync(join(out, file), "utf8"));
    return match ? match[1].trim() : undefined;
  };
  const current = {
    types: Object.fromEntries(Object.keys(fixture.types).map((name) => [name, typeBody(`v2/${name}.ts`, name)])),
    threadStartParamsFields: [...new Set([...readFileSync(join(out, "v2/ThreadStartParams.ts"), "utf8").matchAll(/(\w+)\?:/g)].map((m) => m[1]))].sort(),
    serverRequestMethods: [...new Set([...readFileSync(join(out, "ServerRequest.ts"), "utf8").matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]))].sort(),
    threadResumeParamsFields: [...new Set([...readFileSync(join(out, "v2/ThreadResumeParams.ts"), "utf8").split("export type ThreadResumeParams = ")[1].matchAll(/(\w+)\??:/g)].map((m) => m[1]))].sort(),
    configFields: [...new Set([...readFileSync(join(out, "v2/Config.ts"), "utf8").split("export type Config = ")[1].split("} & (")[0].matchAll(/(\w+): /g)].map((m) => m[1]))].sort(),
    webSearchMode: /export type WebSearchMode = (.*?);/.exec(readFileSync(join(out, "WebSearchMode.ts"), "utf8"))?.[1],
    dynamicToolCallItem: (/\{ "type": "dynamicToolCall",[\s\S]*?\}/.exec(readFileSync(join(out, "v2/ThreadItem.ts"), "utf8"))?.[0] ?? "")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " "),
  };
  const drift = [];
  for (const [name, body] of Object.entries(fixture.types)) if (current.types[name] !== body) drift.push(`type ${name}:\n  recorded: ${body}\n  now:      ${current.types[name]}`);
  for (const field of ["dynamicTools", "config", "developerInstructions", "cwd"]) {
    if (!current.threadStartParamsFields.includes(field)) drift.push(`ThreadStartParams lost ${field}`);
  }
  if (!current.serverRequestMethods.includes("item/tool/call")) drift.push("ServerRequest lost item/tool/call");
  for (const field of ["threadId", "config", "developerInstructions", "cwd"]) {
    if (!current.threadResumeParamsFields.includes(field)) drift.push(`ThreadResumeParams lost ${field}`);
  }
  if (!current.configFields.includes("web_search")) drift.push("Config lost web_search");
  if (current.webSearchMode !== fixture.webSearchMode) drift.push(`WebSearchMode:\n  recorded: ${fixture.webSearchMode}\n  now:      ${current.webSearchMode}`);
  if (current.dynamicToolCallItem !== fixture.dynamicToolCallItem) drift.push(`dynamicToolCall item:\n  recorded: ${fixture.dynamicToolCallItem}\n  now:      ${current.dynamicToolCallItem}`);
  console.log(`installed: ${version}; recorded: codex-cli ${fixture.cliVersion}`);
  if (drift.length === 0) {
    console.log("dynamic tools: same shapes as recorded");
  } else {
    console.log(`dynamic tools: ${drift.length} difference(s)\n${drift.join("\n")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
