import { describe, expect, it } from "vitest";
import type { MergedSession } from "./sessionGrouping";
import { buildSearchIndex, searchSessions, MAX_INDEXED_TITLE_CHARS, type SearchGroup } from "./sessionSearch";

function session(id: string, title: string, profileId = "a"): MergedSession {
  return { id, title, profileId, lastActiveAt: null };
}

function ids(groups: SearchGroup[]): string[] {
  return groups.flatMap((group) => group.results.map((result) => result.session.id));
}

function run(titles: [string, string][], query: string): SearchGroup[] {
  return searchSessions(buildSearchIndex(titles.map(([id, title]) => session(id, title))), query);
}

describe("searchSessions", () => {
  it("needs every word, in any order", () => {
    const hits = run([["1", "Polish the relay for ios"], ["2", "relay only"]], "ios relay");
    expect(ids(hits)).toEqual(["1"]);
  });

  it("ignores case and accents on both sides", () => {
    expect(ids(run([["1", "Migração do banco"]], "MIGRACAO"))).toEqual(["1"]);
    expect(ids(run([["1", "Migracao do banco"]], "migração"))).toEqual(["1"]);
  });

  it("ranks a title start over a word start over mid-word, then keeps recency", () => {
    const hits = run(
      [["mid", "xxfix it"], ["word", "do fix it"], ["start", "fix it"], ["word2", "also fix"]],
      "fix",
    );
    expect(ids(hits)).toEqual(["start", "word", "word2", "mid"]);
  });

  it("counts a hit after - / : as a word start", () => {
    const hits = run([["mid", "xxfix"], ["slash", "a/fix"]], "fix");
    expect(ids(hits)).toEqual(["slash", "mid"]);
  });

  it("orders profile groups by their best result", () => {
    const index = buildSearchIndex([session("1", "zz fix", "a"), session("2", "fix", "b")]);
    expect(searchSessions(index, "fix").map((group) => group.profileId)).toEqual(["b", "a"]);
  });

  it("returns ranges on the original title, even when accents change the normalized length", () => {
    const [group] = run([["1", "Ação de migração"]], "migracao");
    const { ranges, session: hit } = group.results[0];
    expect(ranges.map(([start, end]) => hit.title.slice(start, end))).toEqual(["migração"]);
  });

  it("merges overlapping ranges", () => {
    const [group] = run([["1", "relay relayed"]], "rel relay");
    const { ranges, session: hit } = group.results[0];
    expect(ranges.map(([start, end]) => hit.title.slice(start, end))).toEqual(["relay"]);
  });

  it("with no query lists the 8 most recent, grouped by profile", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(String(i), `t${i}`, i % 2 ? "b" : "a"));
    const groups = searchSessions(buildSearchIndex(sessions), "  ");
    expect(ids(groups)).toEqual(["0", "2", "4", "6", "1", "3", "5", "7"]);
  });

  it("only looks at the first characters of a title", () => {
    const long = `${"a ".repeat(MAX_INDEXED_TITLE_CHARS)}needle`;
    expect(ids(run([["1", long]], "needle"))).toEqual([]);
  });

  it("stays fast over a real-sized list with a 27k-character title", () => {
    const titles: [string, string][] = Array.from({ length: 620 }, (_, i) => [String(i), `Session ${i} about the sidebar layout`]);
    titles[7] = ["7", `${"the sidebar is here ".repeat(1400)}`];
    const index = buildSearchIndex(titles.map(([id, title]) => session(id, title)));
    const started = performance.now();
    const hits = searchSessions(index, "sidebar");
    expect(performance.now() - started).toBeLessThan(20);
    expect(ids(hits)).toHaveLength(620);
  });
});
