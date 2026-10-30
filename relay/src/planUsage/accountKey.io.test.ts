import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_SALT_BYTES, ACCOUNT_SALT_FILE, loadOrCreateAccountSalt } from "./accountKey.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "anywh-account-salt-"));
}

test("creates a 32-byte 0600 salt (and its dir) on first use, then reuses it", async () => {
  const dir = join(tempDir(), "config", "anywh");
  const first = await loadOrCreateAccountSalt(dir);
  assert.equal(first?.length, ACCOUNT_SALT_BYTES);
  const path = join(dir, ACCOUNT_SALT_FILE);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await loadOrCreateAccountSalt(dir), first);
  assert.deepEqual(new Uint8Array(readFileSync(path)), first);
  assert.deepEqual(readdirSync(dir), [ACCOUNT_SALT_FILE]);
});

test("concurrent first uses in one process agree on one salt and leave no temp file", async () => {
  const dir = tempDir();
  const salts = await Promise.all(Array.from({ length: 16 }, () => loadOrCreateAccountSalt(dir)));
  for (const salt of salts) assert.deepEqual(salt, salts[0]);
  assert.deepEqual(readdirSync(dir), [ACCOUNT_SALT_FILE]);
});

// Two relays (profiles) starting together on the same machine.
test("two processes racing to create the salt end up with the same one", async () => {
  const dir = tempDir();
  const moduleUrl = new URL("./accountKey.ts", import.meta.url).href;
  const script = `const { loadOrCreateAccountSalt } = await import(${JSON.stringify(moduleUrl)});
const salt = await loadOrCreateAccountSalt(${JSON.stringify(dir)});
process.stdout.write(Buffer.from(salt).toString("hex"));`;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.length, ACCOUNT_SALT_BYTES * 2);
  assert.equal(a, b);
  assert.equal(readFileSync(join(dir, ACCOUNT_SALT_FILE)).toString("hex"), a);
  assert.deepEqual(readdirSync(dir), [ACCOUNT_SALT_FILE]);
});

test("an unusable salt file turns keys off and is left as it is", async () => {
  const dir = tempDir();
  const path = join(dir, ACCOUNT_SALT_FILE);
  writeFileSync(path, "short", { mode: 0o600 });
  assert.equal(await loadOrCreateAccountSalt(dir), undefined);
  assert.equal(readFileSync(path, "utf8"), "short");
});
