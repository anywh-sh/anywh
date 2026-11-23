import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Fixtures are real ELF shared objects compiled here with the host's C/C++
// compiler (the CI runner has gcc/g++ preinstalled), so objdump reads the
// same kind of symbol-version table a node-gyp build of node-pty carries.
// Their actual requirements are whatever the host toolchain emits, so the
// "over the floor" cases lower the floor through the script's env overrides
// instead of depending on the runner's glibc being new enough.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-glibc-floor.sh");

const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const needsToolchain = !(has("cc") && has("c++") && has("objdump"));

let root;

function compile(compiler, source, ext, out) {
  const src = join(root, `src-${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(src, source);
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync(compiler, ["-shared", "-fPIC", "-o", out, src], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

function fixtureDir(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(dir, env = {}) {
  return spawnSync("sh", [SCRIPT, dir], { encoding: "utf8", env: { ...process.env, ...env } });
}

const C_MODULE = '#include <stdio.h>\nvoid hello(void) { puts("hi"); }\n';
const CXX_MODULE =
  '#include <string>\nextern "C" unsigned long len(const char *s) { return std::string(s).size(); }\n';

before(() => {
  root = mkdtempSync(join(tmpdir(), "glibc-floor-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("passes a module within the default floor, and skips non-ELF prebuilds", { skip: needsToolchain }, () => {
  const dir = fixtureDir("pass");
  // A space in the path: the file list must not be word-split.
  compile("cc", C_MODULE, "c", join(dir, "build dir", "pty.node"));
  writeFileSync(join(dir, "darwin.node"), "\xcf\xfa\xed\xfe not an ELF");
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /build dir\/pty\.node: GLIBC_/);
  assert.doesNotMatch(r.stdout, /darwin\.node/);
});

test("fails a module that needs a newer glibc than the floor", { skip: needsToolchain }, () => {
  const dir = fixtureDir("glibc-over");
  compile("cc", C_MODULE, "c", join(dir, "pty.node"));
  const r = run(dir, { GLIBC_FLOOR: "2.0" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::.*pty\.node needs GLIBC_[0-9.]+, newer than the GLIBC_2\.0 floor/);
});

test("fails a C++ module that needs a newer libstdc++ than the floor", { skip: needsToolchain }, () => {
  const dir = fixtureDir("glibcxx-over");
  compile("c++", CXX_MODULE, "cc", join(dir, "pty.node"));
  assert.equal(run(dir).status, 0, "the host's own libstdc++ needs should pass the default floor");
  const r = run(dir, { GLIBCXX_FLOOR: "3.4" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /needs GLIBCXX_3\.4\.[0-9]+, newer than the GLIBCXX_3\.4 floor/);
});

test("fails an ELF module objdump can't read", { skip: !has("objdump") }, () => {
  const dir = fixtureDir("unreadable");
  writeFileSync(join(dir, "pty.node"), Buffer.from("\x7fELF truncated garbage", "latin1"));
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::.*pty\.node: objdump could not read it/);
});

test("fails when there is no Linux module at all", () => {
  const dir = fixtureDir("no-elf");
  writeFileSync(join(dir, "pty.node"), "MZ not an ELF");
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no Linux native module found/);
});

test("fails with a clear message when objdump is missing", () => {
  const bin = fixtureDir("bin-without-objdump");
  for (const tool of ["sh", "find", "dd", "od", "tr", "mktemp", "rm", "awk", "grep", "sed"]) {
    const path = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (path) symlinkSync(path, join(bin, tool));
  }
  const r = spawnSync(join(bin, "sh"), [SCRIPT, fixtureDir("any")], {
    encoding: "utf8",
    env: { PATH: bin },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /objdump not found/);
});

test("rejects a missing directory argument", () => {
  const r = spawnSync("sh", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
