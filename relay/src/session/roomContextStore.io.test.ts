import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encode } from "gpt-tokenizer";
import { extractPdfText } from "../host/pdfText.js";
import { CONTEXT_ITEMS_MAX, CONTEXT_ITEM_MAX_BYTES, INDEX_FILE, RoomContextStore, sanitizeItemName } from "./roomContextStore.js";

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "anywh-room-context-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const newRoom = (): string => `room-${++counter}`;
const store = (extra: Partial<ConstructorParameters<typeof RoomContextStore>[0]> = {}): RoomContextStore => new RoomContextStore({ root, ...extra });

test("an attachment becomes a file of the room's folder and a line of its index", async () => {
  const s = store();
  const room = newRoom();
  const added = await s.add(room, { name: "brief.md", data: Buffer.from("# Checkout redesign\n\nMake the cart faster.\n"), author: "user" });
  assert.ok(added.ok);
  assert.equal(added.item.lines, 3);
  assert.equal(readFileSync(join(s.dirFor(room), "brief.md"), "utf8"), "# Checkout redesign\n\nMake the cart faster.\n");
  const index = readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8");
  assert.match(index, /`brief\.md` · text · 3 lines · user · Checkout redesign/);
  assert.ok(encode(index).length < 300);
});

test("removing an item deletes its file and its extraction and rewrites the index", async () => {
  const s = store({ extractPdf: () => Promise.resolve({ text: "Spec of the API\nsecond line", pages: 2 }) });
  const room = newRoom();
  await s.add(room, { name: "keep.txt", data: Buffer.from("keep me"), author: "user" });
  const pdf = await s.add(room, { name: "spec.pdf", data: Buffer.from("%PDF-1.4 fake"), author: "user" });
  assert.ok(pdf.ok);
  assert.equal(pdf.item.extraction, "spec.pdf.txt");
  assert.equal(pdf.item.pages, 2);
  assert.match(readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8"), /`spec\.pdf` · text in `spec\.pdf\.txt` · pdf · 2 pages/);
  assert.equal(await s.remove(room, "spec.pdf"), true);
  assert.equal(await s.remove(room, "spec.pdf"), false);
  assert.deepEqual(readdirSync(s.dirFor(room)).filter((f) => !f.startsWith(".")).sort(), [INDEX_FILE, "keep.txt"]);
  const index = readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8");
  assert.doesNotMatch(index, /spec\.pdf/);
  assert.match(index, /keep\.txt/);
});

test("a PDF whose text cannot be extracted is kept, and the index says so", async () => {
  const s = store({ extractPdf: () => Promise.resolve(undefined) });
  const room = newRoom();
  const added = await s.add(room, { name: "scan.pdf", data: Buffer.from("%PDF-1.4"), author: "user" });
  assert.ok(added.ok);
  assert.match(added.warning ?? "", /could not be extracted/);
  assert.match(readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8"), /scan\.pdf` · pdf · \d+ B · user · PDF whose text could not be extracted/);
});

test("pdftotext extracts a real PDF once, when it is installed", async (t) => {
  const probe = await extractPdfText("/nonexistent.pdf");
  assert.equal(probe, undefined, "a missing file extracts nothing");
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("pdftotext", ["-v"]).error) {
    t.skip("pdftotext is not installed here");
    return;
  }
  const pdf = join(root, "hello.pdf");
  // A one-page PDF written by hand, text "Hello room".
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 12 Tf 20 50 Td (Hello room) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(pdf, body);
  const extracted = await extractPdfText(pdf);
  assert.match(extracted?.text ?? "", /Hello room/);
  assert.equal(extracted?.pages, 1);
});

test("a file an agent dropped into the folder is adopted and credited to the agent that listed it", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "brief.md", data: Buffer.from("brief"), author: "user" });
  const dir = s.dirFor(room);
  writeFileSync(join(dir, "result-research.md"), "# Findings\nthree of them\n");
  writeFileSync(join(dir, "scratch.log"), "noise\n");
  mkdirSync(join(dir, "subdir"));
  writeFileSync(join(dir, "subdir", "deep.md"), "not top level");
  const items = await s.sync(room, { author: "Research agent", artifacts: [join(dir, "result-research.md")] });
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName["result-research.md"]?.author, "Research agent");
  assert.equal(byName["result-research.md"]?.summary, "Findings");
  assert.equal(byName["scratch.log"]?.author, "unknown");
  assert.equal(byName["deep.md"], undefined, "only the folder's own files are items");
  assert.match(readFileSync(join(dir, INDEX_FILE), "utf8"), /result-research\.md` · text · 2 lines · Research agent · Findings/);
});

test("an item whose file was deleted by hand leaves the index, and an edited result is re-read", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "a.md", data: Buffer.from("first draft\n"), author: "user" });
  await s.add(room, { name: "b.md", data: Buffer.from("other\n"), author: "user" });
  const dir = s.dirFor(room);
  rmSync(join(dir, "b.md"));
  writeFileSync(join(dir, "a.md"), "second draft\nwith two lines\n");
  const items = await s.sync(room);
  assert.deepEqual(items.map((i) => i.name), ["a.md"]);
  assert.equal(items[0]?.lines, 2);
  assert.match(readFileSync(join(dir, INDEX_FILE), "utf8"), /a\.md` · text · 2 lines · user · second draft/);
});

test("an interrupted upload (file landed, manifest and index did not) is repaired by the next sync", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "old.md", data: Buffer.from("old"), author: "user" });
  const dir = s.dirFor(room);
  writeFileSync(join(dir, "landed.md"), "landed before the crash\n");
  rmSync(join(dir, INDEX_FILE));
  const fresh = store();
  const index = await fresh.index(room);
  assert.match(index, /landed\.md/);
  assert.match(index, /old\.md/);
});

test("many uploads at once are all kept, none overwriting another, with one index naming them all", async () => {
  const s = store();
  const room = newRoom();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => s.add(room, { name: "same.txt", data: Buffer.from(`copy ${i}\n`), author: "user" })));
  assert.ok(results.every((r) => r.ok));
  const names = results.map((r) => (r.ok ? r.item.name : ""));
  assert.equal(new Set(names).size, 12);
  const index = readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8");
  for (const name of names) assert.ok(index.includes(`\`${name}\``), `${name} listed`);
});

test("names are one safe path segment and the index files are not ours to overwrite", async () => {
  assert.equal(sanitizeItemName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeItemName("C:\\Users\\me\\notes.md"), "notes.md");
  assert.equal(sanitizeItemName(".hidden"), "hidden");
  assert.equal(sanitizeItemName("INDEX.md"), undefined);
  assert.equal(sanitizeItemName(".items.json"), "items.json");
  assert.equal(sanitizeItemName("   "), undefined);
  const s = store();
  const room = newRoom();
  const refused = await s.add(room, { name: "INDEX.md", data: Buffer.from("mine now"), author: "user" });
  assert.equal(refused.ok, false);
  assert.throws(() => s.dirFor("../escape"), /invalid room id/);
  assert.throws(() => s.dirFor("a/b"), /invalid room id/);
});

test("an empty file, and a room past its item limit, are refused with a reason", async () => {
  const s = store();
  const room = newRoom();
  const empty = await s.add(room, { name: "e.txt", data: Buffer.alloc(0), author: "user" });
  assert.deepEqual(empty.ok ? undefined : empty.status, 400);
  const dir = s.dirFor(room);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".items.json"), JSON.stringify({ items: Array.from({ length: CONTEXT_ITEMS_MAX }, (_, i) => ({ name: `f${i}`, kind: "text", bytes: 1, author: "user", summary: "", at: i })) }));
  const full = await s.add(room, { name: "one-more.txt", data: Buffer.from("x"), author: "user" });
  assert.equal(full.ok ? undefined : full.status, 409);
});

test("a large text carries a warning and a size flag in the index", async () => {
  const s = store();
  const room = newRoom();
  const big = Buffer.from(`${"lorem ipsum dolor sit amet\n".repeat(4000)}`);
  const added = await s.add(room, { name: "dump.txt", data: big, author: "user" });
  assert.ok(added.ok);
  assert.match(added.warning ?? "", /read parts of it on demand/);
  assert.match(readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8"), /LARGE \(~\d+k tokens\)/);
});

test("a binary file and an image are listed without being read as text", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), author: "user" });
  await s.add(room, { name: "blob.bin", data: Buffer.from([0, 1, 2, 3]), author: "user" });
  const index = readFileSync(join(s.dirFor(room), INDEX_FILE), "utf8");
  assert.match(index, /logo\.png` · image · 7 B · user · image; open it with Read/);
  assert.match(index, /blob\.bin` · binary/);
});

test("deleting a room removes its folder; pruning removes folders of rooms that are gone and nothing else", async () => {
  const s = store();
  const gone = newRoom();
  const live = newRoom();
  const deleted = newRoom();
  for (const room of [gone, live, deleted]) await s.add(room, { name: "x.md", data: Buffer.from("x"), author: "user" });
  s.deleteRoom(deleted);
  assert.equal(existsSync(s.dirFor(deleted)), false);
  writeFileSync(join(root, "not-a-room-folder.txt"), "mine");
  const removed = s.pruneOrphans(new Set([live]));
  assert.ok(removed.includes(gone));
  assert.ok(!removed.includes(live));
  assert.equal(existsSync(s.dirFor(gone)), false);
  assert.equal(existsSync(s.dirFor(live)), true);
  assert.equal(existsSync(join(root, "not-a-room-folder.txt")), true);
});

test("a manifest an agent forged cannot make the relay delete a file outside the folder", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "brief.md", data: Buffer.from("brief"), author: "user" });
  const dir = s.dirFor(room);
  const victim = join(root, `victim-${counter}.txt`);
  writeFileSync(victim, "precious");
  const forged = { name: "gone.md", kind: "text", bytes: 1, author: "x", summary: "x", at: 1, extraction: `../${victim.split("/").pop()}` };
  const traversal = { ...forged, name: `../${victim.split("/").pop()}`, extraction: undefined };
  writeFileSync(join(dir, ".items.json"), JSON.stringify({ items: [forged, traversal] }));
  await s.sync(room);
  assert.equal(await s.remove(room, traversal.name), false);
  assert.equal(readFileSync(victim, "utf8"), "precious");
});

test("a link planted where the relay writes its temporary files is never written through", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "brief.md", data: Buffer.from("brief"), author: "user" });
  const dir = s.dirFor(room);
  const victim = join(root, `victim-link-${counter}.txt`);
  writeFileSync(victim, "precious");
  for (const name of [".items.json.tmp", "INDEX.md.tmp", "next.md.tmp"]) symlinkSync(victim, join(dir, name));
  await s.add(room, { name: "next.md", data: Buffer.from("next"), author: "user" });
  assert.equal(readFileSync(victim, "utf8"), "precious");
  assert.equal(readFileSync(join(dir, "next.md"), "utf8"), "next");
});

test("an upload named like a temporary file stays in the index", async () => {
  const s = store();
  const room = newRoom();
  assert.ok((await s.add(room, { name: "notes.tmp", data: Buffer.from("scratch notes"), author: "user" })).ok);
  assert.deepEqual((await s.sync(room)).map((item) => item.name), ["notes.tmp"]);
});

test("a file an agent wrote past the size cap is not read, and the others are still adopted", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "brief.md", data: Buffer.from("brief"), author: "user" });
  const dir = s.dirFor(room);
  writeFileSync(join(dir, "huge.bin"), "");
  truncateSync(join(dir, "huge.bin"), CONTEXT_ITEM_MAX_BYTES + 1);
  writeFileSync(join(dir, "result-ok.md"), "# fine\n");
  const names = (await s.sync(room)).map((item) => item.name).sort();
  assert.deepEqual(names, ["brief.md", "result-ok.md"]);
});

test("a FIFO, or a directory, an agent put where the relay's own files go does not wedge the room", async () => {
  const s = store();
  const room = newRoom();
  await s.add(room, { name: "brief.md", data: Buffer.from("brief"), author: "user" });
  const dir = s.dirFor(room);
  for (const name of ["INDEX.md", ".items.json"]) {
    rmSync(join(dir, name));
    assert.equal(spawnSync("mkfifo", [join(dir, name)]).status, 0);
  }
  assert.deepEqual((await s.sync(room)).map((item) => item.name), ["brief.md"], "a manifest swapped for a FIFO is not waited on: the folder is re-read instead");
  assert.match(s.indexNow(room), /^# /m);
  mkdirSync(join(dir, ".tmp-leftover"));
  rmSync(join(dir, "INDEX.md"));
  mkdirSync(join(dir, "INDEX.md"));
  const added = await s.add(room, { name: "again.md", data: Buffer.from("again"), author: "user" });
  assert.ok(added.ok);
  assert.deepEqual((await s.sync(room)).map((item) => item.name).sort(), ["again.md", "brief.md"]);
  assert.match(readFileSync(join(dir, INDEX_FILE), "utf8"), /again\.md/);
  assert.equal(existsSync(join(dir, ".tmp-leftover")), false);
});

test("a long name in a wide script is cut by bytes, so the file can be written", async () => {
  const s = store();
  const room = newRoom();
  const added = await s.add(room, { name: `${"文".repeat(100)}.md`, data: Buffer.from("x"), author: "user" });
  assert.ok(added.ok, added.ok ? "" : added.error);
  assert.ok(Buffer.byteLength(added.item.name) <= 255);
  assert.ok(existsSync(join(s.dirFor(room), added.item.name)));
});
