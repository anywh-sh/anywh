// The work-ticket links' file in a real tmpdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketLinks, createFileTicketLinksStore } from "./ticketLinks.js";

test("the file is written whole (0600), read back by the next relay, and another version is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-ticket-links-"));
  try {
    const path = join(dir, "nested", "sessions-ticket-links.json");
    const first = new TicketLinks({ store: createFileTicketLinksStore(path) });
    first.link("s1", { provider: "jira", site: "site-1", key: "NGL-1" }, "manual", { lineDue: true });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { version: number }).version, 1);

    const second = new TicketLinks({ store: createFileTicketLinksStore(path) });
    assert.equal(second.get("s1")?.ticket.key, "NGL-1");
    assert.equal(second.get("s1")?.lineDue, true);

    writeFileSync(path, JSON.stringify({ version: 99, bySession: { s1: second.get("s1") } }));
    assert.deepEqual(new TicketLinks({ store: createFileTicketLinksStore(path) }).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
