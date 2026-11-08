// The integrations file in a real tmpdir: written by tmp+rename with mode
// 0600, read back field by field, and dropped when its version differs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileIntegrationsStore, integrationsPathFor, type PersistedIntegrations } from "./store.js";

const NOW = 1_793_320_000_000;

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-integrations-store-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATE: PersistedIntegrations = {
  inventory: [
    {
      runtimeId: "claude",
      name: "claude.ai Atlassian",
      scope: "claudeai",
      transport: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp" },
      status: "connected",
      authMode: "claudeai",
      serverInfoName: "atlassian-mcp-server",
      tools: [{ name: "getJiraIssue", readOnly: true }, { name: "editJiraIssue" }],
      claudeConfig: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp", id: "mcpsrv_00000000000000000000000001" },
      scannedAt: NOW,
    },
  ],
  integrations: {
    jira: {
      site: { id: "00000000-0000-4000-8000-000000000001", url: "https://example-site.atlassian.net", name: "example-site" },
      prefs: { project: "NGL" },
      queries: [
        {
          query: "mine",
          param: null,
          items: [{ key: "NGL-1", id: "10001", title: "First", statusCategory: "doing", statusLabel: "In Progress", priority: "High", project: "NGL", updatedAt: NOW, url: "https://example-site.atlassian.net/browse/NGL-1" }],
          nextPageToken: "page-2",
          observedAt: NOW,
          source: "manual",
        },
        {
          query: "ticket",
          param: "NGL-1",
          detail: {
            key: "NGL-1",
            id: "10001",
            title: "First",
            statusCategory: "doing",
            statusLabel: "In Progress",
            project: "NGL",
            updatedAt: NOW,
            url: "https://example-site.atlassian.net/browse/NGL-1",
            descriptionMd: "Body",
            comments: [{ author: "Someone", createdAt: NOW, bodyMd: "A comment" }],
          },
          observedAt: NOW,
        },
      ],
    },
  },
};

test("the path sits beside the sessions file", () => {
  assert.equal(integrationsPathFor("/x/pessoal.json"), "/x/pessoal-integrations.json");
  assert.equal(integrationsPathFor("/x/sessions"), "/x/sessions-integrations.json");
});

test("save then load round-trips, written 0600 with no temp file left", () => {
  withDir((dir) => {
    const path = join(dir, "nested", "p-integrations.json");
    const store = createFileIntegrationsStore(path);
    assert.equal(store.load(), undefined, "no file yet");
    store.save(STATE);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { version: number }).version, 1);
    assert.deepEqual(store.load(), STATE);
  });
});

test("a file of another version is dropped whole", () => {
  withDir((dir) => {
    const path = join(dir, "p-integrations.json");
    writeFileSync(path, JSON.stringify({ version: 2, ...STATE }));
    assert.equal(createFileIntegrationsStore(path).load(), undefined);
    writeFileSync(path, "{not json");
    assert.equal(createFileIntegrationsStore(path).load(), undefined);
  });
});

test("entries that do not check out are dropped one by one", () => {
  withDir((dir) => {
    const path = join(dir, "p-integrations.json");
    const jira = STATE.integrations.jira;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        inventory: [STATE.inventory[0], { ...STATE.inventory[0], runtimeId: "gemini" }, { name: "no fields" }],
        integrations: {
          jira: {
            ...jira,
            prefs: { project: 'NGL" OR project = "X' },
            queries: [
              { ...jira.queries[0], items: [jira.queries[0].query === "mine" ? jira.queries[0].items[0] : null, { key: "not-a-key" }] },
              { query: "ticket", param: "NGL-2", detail: { key: "NGL-2" }, observedAt: NOW },
              { query: "mine", param: "lowercase", items: [], observedAt: NOW },
            ],
          },
        },
      }),
    );
    const loaded = createFileIntegrationsStore(path).load();
    assert.ok(loaded);
    assert.equal(loaded.inventory.length, 1);
    assert.deepEqual(loaded.integrations.jira.prefs, { project: null });
    assert.equal(loaded.integrations.jira.queries.length, 1);
    const [mine] = loaded.integrations.jira.queries;
    assert.ok(mine.query === "mine");
    assert.deepEqual(mine.items.map((item) => item.key), ["NGL-1"]);
  });
});
