import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, deleteFile, listFiles, readFileForViewer, renameFile, resolveChatPath, resolveRawFile, resolveWithinRoot } from "./fsFiles.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-fsfiles-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveWithinRoot: no path given resolves to the root itself", () => {
  withTempDir((dir) => {
    assert.deepEqual(resolveWithinRoot(dir, null), { ok: true, root: dir, path: dir });
  });
});

test("resolveWithinRoot: rejects a relative path", () => {
  withTempDir((dir) => {
    assert.deepEqual(resolveWithinRoot(dir, "relative/path"), { ok: false, error: "invalid_path" });
  });
});

test("resolveWithinRoot: rejects a path that resolves outside the root", () => {
  withTempDir((outer) => {
    withTempDir((root) => {
      // A real, existing path that just isn't under `root` — this is what a
      // `../` traversal collapses down to once `path.resolve` normalizes it.
      const result = resolveWithinRoot(root, outer);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "outside_root");
    });
  });
});

test("resolveWithinRoot: rejects a symlink that escapes the root", () => {
  withTempDir((outer) => {
    withTempDir((root) => {
      const target = join(outer, "secret.txt");
      writeFileSync(target, "conteúdo secreto");
      const link = join(root, "link-pra-fora");
      symlinkSync(target, link);

      const result = resolveWithinRoot(root, link);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "outside_root");
    });
  });
});

test("resolveWithinRoot: nonexistent path propagates not_found", () => {
  withTempDir((dir) => {
    const result = resolveWithinRoot(dir, join(dir, "nao-existe"));
    assert.deepEqual(result, { ok: false, error: "not_found" });
  });
});

test("listFiles: directories before files, alphabetical within each group", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "pasta-b"));
    mkdirSync(join(dir, "pasta-a"));
    writeFileSync(join(dir, "b.txt"), "b");
    writeFileSync(join(dir, "a.txt"), "a");

    const result = listFiles(dir, null, false);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.entries.map((e) => [e.name, e.kind]),
      [
        ["pasta-a", "dir"],
        ["pasta-b", "dir"],
        ["a.txt", "file"],
        ["b.txt", "file"],
      ],
    );
  });
});

test("listFiles: dotfiles and node_modules are hidden by default, shown with showHidden", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".env"), "SECRET=1");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "visible.txt"), "conteúdo");

    const filtered = listFiles(dir, null, false);
    assert.equal(filtered.ok, true);
    if (filtered.ok) assert.deepEqual(filtered.entries.map((e) => e.name), ["visible.txt"]);

    const all = listFiles(dir, null, true);
    assert.equal(all.ok, true);
    if (all.ok) {
      assert.deepEqual(
        all.entries.map((e) => e.name).sort(),
        [".env", "node_modules", "visible.txt"],
      );
    }
  });
});

test("listFiles: a path outside the root is rejected", () => {
  withTempDir((outer) => {
    withTempDir((root) => {
      const result = listFiles(root, outer, false);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "outside_root");
    });
  });
});

test("readFileForViewer: plain text file", () => {
  withTempDir((dir) => {
    const file = join(dir, "notas.txt");
    writeFileSync(file, "linha 1\nlinha 2\n");

    const result = readFileForViewer(dir, file);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.kind, "text");
    if (result.kind === "text") {
      assert.equal(result.content, "linha 1\nlinha 2\n");
      assert.equal(result.truncated, false);
    }
  });
});

test("readFileForViewer: a large text file is truncated at the byte cap", () => {
  withTempDir((dir) => {
    const file = join(dir, "grande.txt");
    const size = 2 * 1024 * 1024 + 10;
    writeFileSync(file, Buffer.alloc(size, "a"));

    const result = readFileForViewer(dir, file);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.kind, "text");
    if (result.kind === "text") {
      assert.equal(result.truncated, true);
      assert.equal(result.content.length, 2 * 1024 * 1024);
      assert.equal(result.size, size);
    }
  });
});

test("readFileForViewer: a file with a null byte is classified as binary", () => {
  withTempDir((dir) => {
    const file = join(dir, "dados.bin");
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const result = readFileForViewer(dir, file);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.kind, "binary");
  });
});

test("readFileForViewer: an image is detected by extension, without reading its bytes", () => {
  withTempDir((dir) => {
    const file = join(dir, "foto.png");
    // Deliberately not a real PNG — detection is extension-only, this
    // proves the content is never sniffed for image files.
    writeFileSync(file, "not actually a png");

    const result = readFileForViewer(dir, file);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.kind, "image");
      if (result.kind === "image") assert.equal(result.mime, "image/png");
    }
  });
});

test("readFileForViewer: an empty file is text, not binary", () => {
  withTempDir((dir) => {
    const file = join(dir, "vazio.txt");
    writeFileSync(file, "");

    const result = readFileForViewer(dir, file);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.kind, "text");
  });
});

test("resolveRawFile: resolves mime by extension", () => {
  withTempDir((dir) => {
    const file = join(dir, "foto.webp");
    writeFileSync(file, "bytes");

    const result = resolveRawFile(dir, file);
    assert.deepEqual(result, { ok: true, path: file, mime: "image/webp" });
  });
});

test("resolveRawFile: nonexistent file propagates not_found", () => {
  withTempDir((dir) => {
    const result = resolveRawFile(dir, join(dir, "nao-existe.png"));
    assert.deepEqual(result, { ok: false, error: "not_found" });
  });
});

test("deleteFile: removes the file", () => {
  withTempDir((dir) => {
    const file = join(dir, "descarte.txt");
    writeFileSync(file, "lixo");

    assert.deepEqual(deleteFile(dir, file), { ok: true });
    assert.equal(existsSync(file), false);
  });
});

test("deleteFile: a directory is rejected as not_found", () => {
  withTempDir((dir) => {
    const sub = join(dir, "pasta");
    mkdirSync(sub);

    const result = deleteFile(dir, sub);
    assert.deepEqual(result, { ok: false, error: "not_found" });
    assert.equal(existsSync(sub), true);
  });
});

test("deleteFile: a path outside the root is rejected", () => {
  withTempDir((outer) => {
    withTempDir((root) => {
      const file = join(outer, "fora.txt");
      writeFileSync(file, "fora");

      const result = deleteFile(root, file);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "outside_root");
      assert.equal(existsSync(file), true);
    });
  });
});

test("renameFile: renames within the same directory", () => {
  withTempDir((dir) => {
    const file = join(dir, "antigo.txt");
    writeFileSync(file, "conteúdo");

    const result = renameFile(dir, file, "novo.txt");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.path, join(dir, "novo.txt"));
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(join(dir, "novo.txt")), true);
  });
});

test("renameFile: a name containing a path separator is rejected", () => {
  withTempDir((dir) => {
    const file = join(dir, "antigo.txt");
    writeFileSync(file, "conteúdo");

    const result = renameFile(dir, file, "../fora.txt");
    assert.deepEqual(result, { ok: false, error: "invalid_name" });
    assert.equal(existsSync(file), true);
  });
});

test("createFile: creates an empty file at the root", () => {
  withTempDir((dir) => {
    const result = createFile(dir, null, "novo.txt");
    assert.deepEqual(result, { ok: true, path: join(dir, "novo.txt") });
    assert.equal(existsSync(join(dir, "novo.txt")), true);
  });
});

test("createFile: creates inside a subdirectory", () => {
  withTempDir((dir) => {
    const sub = join(dir, "pasta");
    mkdirSync(sub);

    const result = createFile(dir, sub, "novo.txt");
    assert.deepEqual(result, { ok: true, path: join(sub, "novo.txt") });
  });
});

test("createFile: a name that already exists is rejected, never truncated", () => {
  withTempDir((dir) => {
    const file = join(dir, "existente.txt");
    writeFileSync(file, "conteúdo original");

    const result = createFile(dir, null, "existente.txt");
    assert.deepEqual(result, { ok: false, error: "already_exists" });
    const afterwards = readFileForViewer(dir, file);
    assert.equal(afterwards.ok, true);
    if (afterwards.ok && afterwards.kind === "text") assert.equal(afterwards.content, "conteúdo original");
  });
});

test("createFile: a name containing a path separator is rejected", () => {
  withTempDir((dir) => {
    const result = createFile(dir, null, "../fora.txt");
    assert.deepEqual(result, { ok: false, error: "invalid_name" });
  });
});

test("createFile: a target directory outside the root is rejected", () => {
  withTempDir((outer) => {
    withTempDir((root) => {
      const result = createFile(root, outer, "novo.txt");
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "outside_root");
    });
  });
});

test("renameFile: a name that already exists in the directory is rejected", () => {
  withTempDir((dir) => {
    const file = join(dir, "antigo.txt");
    writeFileSync(file, "conteúdo");
    writeFileSync(join(dir, "novo.txt"), "já existe");

    const result = renameFile(dir, file, "novo.txt");
    assert.deepEqual(result, { ok: false, error: "already_exists" });
    assert.equal(existsSync(file), true);
  });
});

test("resolveChatPath: a full relative path that exists resolves to the absolute file, ancestors included", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "screenshots", "PROJ-929"), { recursive: true });
    writeFileSync(join(root, "screenshots", "PROJ-929", "foo.png"), "");

    const result = resolveChatPath(root, "screenshots/PROJ-929/foo.png");
    assert.deepEqual(result, {
      target: join(root, "screenshots", "PROJ-929", "foo.png"),
      isDirectory: false,
      existingDirs: [join(root, "screenshots"), join(root, "screenshots", "PROJ-929")],
    });
  });
});

test("resolveChatPath: a wrong last segment still returns the best-guess target plus every confirmed ancestor", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "relay", "scripts"), { recursive: true });
    // No `anywh-bg` file at that path — the model got the filename (or the
    // session's root) wrong, but `relay/scripts` is real.

    const result = resolveChatPath(root, "relay/scripts/anywh-bg");
    assert.deepEqual(result, {
      target: join(root, "relay", "scripts", "anywh-bg"),
      isDirectory: false,
      existingDirs: [join(root, "relay"), join(root, "relay", "scripts")],
    });
  });
});

test("resolveChatPath: stops the ancestor walk at the first directory that doesn't exist", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "relay"));

    const result = resolveChatPath(root, "relay/scripts/anywh-bg");
    assert.deepEqual(result, {
      target: join(root, "relay", "scripts", "anywh-bg"),
      isDirectory: false,
      existingDirs: [join(root, "relay")],
    });
  });
});

test("resolveChatPath: a trailing slash is treated as a directory — expanded, never opened as a file", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "prototypes", "voice-jarvis"), { recursive: true });

    const result = resolveChatPath(root, "prototypes/voice-jarvis/");
    assert.deepEqual(result, {
      target: null,
      isDirectory: true,
      existingDirs: [join(root, "prototypes"), join(root, "prototypes", "voice-jarvis")],
    });
  });
});

test("resolveChatPath: a bare filename is found by search, ancestors included", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "client", "src", "components", "chat"), { recursive: true });
    writeFileSync(join(root, "client", "src", "components", "chat", "Message.tsx"), "");

    const result = resolveChatPath(root, "Message.tsx");
    assert.deepEqual(result, {
      target: join(root, "client", "src", "components", "chat", "Message.tsx"),
      isDirectory: false,
      existingDirs: [
        join(root, "client"),
        join(root, "client", "src"),
        join(root, "client", "src", "components"),
        join(root, "client", "src", "components", "chat"),
      ],
    });
  });
});

test("resolveChatPath: a bare filename search prefers the shallowest match", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "target.txt"), "shallow");
    writeFileSync(join(root, "a", "b", "target.txt"), "deep");

    const result = resolveChatPath(root, "target.txt");
    assert.equal(result.target, join(root, "a", "target.txt"));
  });
});

test("resolveChatPath: a bare filename search skips node_modules and dotfiles, same as listFiles", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "ghost.txt"), "");
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, ".hidden", "ghost2.txt"), "");

    assert.equal(resolveChatPath(root, "ghost.txt").target, null);
    assert.equal(resolveChatPath(root, "ghost2.txt").target, null);
  });
});

test("resolveChatPath: a bare filename with no match anywhere resolves to nothing", () => {
  withTempDir((root) => {
    const result = resolveChatPath(root, "does-not-exist.txt");
    assert.deepEqual(result, { target: null, isDirectory: false, existingDirs: [] });
  });
});

test("resolveChatPath: an already-absolute path outside the root resolves to nothing", () => {
  withTempDir((outer) => {
    withTempDir((root) => {
      const outerFile = join(outer, "secret.txt");
      writeFileSync(outerFile, "");

      const result = resolveChatPath(root, outerFile);
      assert.deepEqual(result, { target: null, isDirectory: false, existingDirs: [] });
    });
  });
});

test("resolveChatPath: an already-absolute path under the root resolves the same as the relative form", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "screenshots"));
    writeFileSync(join(root, "screenshots", "foo.png"), "");

    const result = resolveChatPath(root, join(root, "screenshots", "foo.png"));
    assert.deepEqual(result, {
      target: join(root, "screenshots", "foo.png"),
      isDirectory: false,
      existingDirs: [join(root, "screenshots")],
    });
  });
});

// The session's root is a workspace folder one level above the repo the
// mention is actually relative to (real bug: root `~/anywh`, mention
// `relay/scripts/anywh-bg`, real file at `~/anywh/anywh/relay/scripts/anywh-bg`)
// — the first segment doesn't exist directly under root, so a naive join
// fails outright and used to return an empty `existingDirs`, expanding
// nothing in the tree. The suffix-search fallback below is what fixes that.

test("resolveChatPath: a multi-segment path relative to a repo nested under the root falls back to a suffix search", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "anywh", "relay", "scripts"), { recursive: true });
    writeFileSync(join(root, "anywh", "relay", "scripts", "anywh-bg"), "");

    const result = resolveChatPath(root, "relay/scripts/anywh-bg");
    assert.deepEqual(result, {
      target: join(root, "anywh", "relay", "scripts", "anywh-bg"),
      isDirectory: false,
      existingDirs: [join(root, "anywh"), join(root, "anywh", "relay"), join(root, "anywh", "relay", "scripts")],
    });
  });
});

test("resolveChatPath: a directory relative to a repo nested under the root also falls back to a suffix search", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "anywh", "prototypes", "voice-jarvis"), { recursive: true });

    const result = resolveChatPath(root, "prototypes/voice-jarvis/");
    assert.deepEqual(result, {
      target: null,
      isDirectory: true,
      existingDirs: [
        join(root, "anywh"),
        join(root, "anywh", "prototypes"),
        join(root, "anywh", "prototypes", "voice-jarvis"),
      ],
    });
  });
});

test("resolveChatPath: the suffix fallback rejects a same-named leaf whose parent chain doesn't match", () => {
  withTempDir((root) => {
    // A `scripts/anywh-bg` exists, but not inside a `relay` folder — the
    // mention's middle segment doesn't match, so this must NOT be treated
    // as a hit even though the final segment's name matches.
    mkdirSync(join(root, "other", "scripts"), { recursive: true });
    writeFileSync(join(root, "other", "scripts", "anywh-bg"), "");

    const result = resolveChatPath(root, "relay/scripts/anywh-bg");
    assert.deepEqual(result, { target: join(root, "relay", "scripts", "anywh-bg"), isDirectory: false, existingDirs: [] });
  });
});

test("resolveChatPath: a multi-segment path present directly under the root is trusted without searching", () => {
  withTempDir((root) => {
    // Same basename pair exists in two places — the direct join (matching
    // what's actually given) must win over the search fallback, which would
    // otherwise be free to return either (BFS visits `nested` first).
    mkdirSync(join(root, "nested", "relay", "scripts"), { recursive: true });
    writeFileSync(join(root, "nested", "relay", "scripts", "anywh-bg"), "decoy");
    mkdirSync(join(root, "relay", "scripts"), { recursive: true });
    writeFileSync(join(root, "relay", "scripts", "anywh-bg"), "real");

    const result = resolveChatPath(root, "relay/scripts/anywh-bg");
    assert.equal(result.target, join(root, "relay", "scripts", "anywh-bg"));
  });
});
