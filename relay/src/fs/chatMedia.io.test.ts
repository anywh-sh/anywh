import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveChatMedia } from "./chatMedia.js";

// Real tmpdir: a session cwd, a home, and a folder outside both standing in
// for /tmp, where a simulator screenshot lands.
function withDirs(run: (dirs: { cwd: string; home: string; outside: string }) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "anywh-chat-media-")));
  const dirs = { cwd: join(base, "project"), home: join(base, "home"), outside: join(base, "elsewhere") };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  try {
    run(dirs);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("resolveChatMedia: an absolute path outside the session's cwd is served", () => {
  withDirs(({ cwd, home, outside }) => {
    const shot = join(outside, "login.png");
    writeFileSync(shot, "png-bytes");
    const result = resolveChatMedia(shot, cwd, home);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.path, shot);
    assert.equal(result.mime, "image/png");
    assert.equal(result.kind, "image");
    assert.equal(result.size, "png-bytes".length);
  });
});

test("resolveChatMedia: a relative path is the session's cwd's, and a bare name is searched under it", () => {
  withDirs(({ cwd, home }) => {
    mkdirSync(join(cwd, "screenshots"));
    writeFileSync(join(cwd, "screenshots", "home.jpg"), "jpg");
    const relative = resolveChatMedia("screenshots/home.jpg", cwd, home);
    assert.equal(relative.ok && relative.path, join(cwd, "screenshots", "home.jpg"));
    const bare = resolveChatMedia("home.jpg", cwd, home);
    assert.equal(bare.ok && bare.path, join(cwd, "screenshots", "home.jpg"));
  });
});

test("resolveChatMedia: `~/` is the profile's home and a file:// URL is its path", () => {
  withDirs(({ cwd, home }) => {
    writeFileSync(join(home, "rec ording.mov"), "mov");
    const tilde = resolveChatMedia("~/rec ording.mov", cwd, home);
    assert.equal(tilde.ok && tilde.kind, "video");
    const url = resolveChatMedia(pathToFileURL(join(home, "rec ording.mov")).href, cwd, home);
    assert.equal(url.ok && url.path, join(home, "rec ording.mov"));
  });
});

test("resolveChatMedia: a file that isn't media is refused even when it exists", () => {
  withDirs(({ cwd, home }) => {
    writeFileSync(join(home, ".env"), "SECRET=1");
    assert.deepEqual(resolveChatMedia(join(home, ".env"), cwd, home), { ok: false, error: "not_media" });
  });
});

test("resolveChatMedia: a media-named symlink to something else is refused by its real path", () => {
  withDirs(({ cwd, home, outside }) => {
    writeFileSync(join(home, "id_ed25519"), "key");
    symlinkSync(join(home, "id_ed25519"), join(outside, "innocent.png"));
    assert.deepEqual(resolveChatMedia(join(outside, "innocent.png"), cwd, home), { ok: false, error: "not_media" });
  });
});

test("resolveChatMedia: a missing file, a directory and an empty path each say so", () => {
  withDirs(({ cwd, home, outside }) => {
    assert.deepEqual(resolveChatMedia(join(outside, "gone.png"), cwd, home), { ok: false, error: "not_found" });
    mkdirSync(join(outside, "folder.png"));
    assert.deepEqual(resolveChatMedia(join(outside, "folder.png"), cwd, home), { ok: false, error: "not_found" });
    assert.deepEqual(resolveChatMedia("   ", cwd, home), { ok: false, error: "invalid_path" });
  });
});
