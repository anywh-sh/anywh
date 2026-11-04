import type { MergedSession } from "./sessionGrouping";

/** Only this many characters of a title are searched. Titles from a relay
 * that predates its own length cap can be a whole model reply, and this runs
 * on every keystroke; a search that reads past the first screenful of a title
 * matches things nobody can see in the row anyway. */
export const MAX_INDEXED_TITLE_CHARS = 200;

/** How many sessions the palette lists before anything is typed. */
export const EMPTY_QUERY_LIMIT = 8;

export interface SearchEntry {
  session: MergedSession;
  /** Lower-cased, accent-free title (clipped to `MAX_INDEXED_TITLE_CHARS`). */
  norm: string;
  /** For each code unit of `norm`, where its source character starts and ends
   * in `session.title`. Not 1:1: an accented letter is two code units once
   * decomposed, and the mark is dropped. */
  starts: number[];
  ends: number[];
}

/** `[start, end)` in the original title. */
export type MatchRange = [number, number];

export interface SearchResult {
  session: MergedSession;
  score: number;
  ranges: MatchRange[];
}

export interface SearchGroup {
  profileId: string;
  results: SearchResult[];
}

const MARKS = /\p{M}/gu;

export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(MARKS, "").toLowerCase();
}

function indexSession(session: MergedSession): SearchEntry {
  const title = session.title.slice(0, MAX_INDEXED_TITLE_CHARS);
  let norm = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of title) {
    const piece = normalizeText(char);
    for (let i = 0; i < piece.length; i++) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    norm += piece;
    offset += char.length;
  }
  return { session, norm, starts, ends };
}

/** Built once per cache write, not per keystroke. `sessions` must already be
 * in the order results should tie-break by (recency). */
export function buildSearchIndex(sessions: readonly MergedSession[]): SearchEntry[] {
  return sessions.map(indexSession);
}

const WORD_BREAKS = new Set([" ", "-", "/", ":"]);

/** The best place `word` occurs in `norm`: 3 at the very start, 2 at the start
 * of a word, 1 in the middle of one. */
function bestOccurrence(norm: string, word: string): { score: number; at: number } | null {
  let best: { score: number; at: number } | null = null;
  for (let at = norm.indexOf(word); at !== -1; at = norm.indexOf(word, at + 1)) {
    const score = at === 0 ? 3 : WORD_BREAKS.has(norm[at - 1]) ? 2 : 1;
    if (!best || score > best.score) best = { score, at };
    if (score === 3) break;
  }
  return best;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function matchEntry(entry: SearchEntry, words: string[]): SearchResult | null {
  let score = 0;
  const ranges: MatchRange[] = [];
  for (const word of words) {
    const found = bestOccurrence(entry.norm, word);
    if (!found) return null;
    score += found.score;
    ranges.push([entry.starts[found.at], entry.ends[found.at + word.length - 1]]);
  }
  return { session: entry.session, score, ranges: mergeRanges(ranges) };
}

/** Results grouped by profile, groups ordered by their best result and
 * results by score then by the index's own (recency) order. */
export function searchSessions(index: readonly SearchEntry[], query: string): SearchGroup[] {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];
  if (words.length === 0) {
    for (const entry of index.slice(0, EMPTY_QUERY_LIMIT)) results.push({ session: entry.session, score: 0, ranges: [] });
  } else {
    for (const entry of index) {
      const result = matchEntry(entry, words);
      if (result) results.push(result);
    }
    // Stable: equal scores keep the index order.
    results.sort((a, b) => b.score - a.score);
  }
  const groups = new Map<string, SearchGroup>();
  for (const result of results) {
    const group = groups.get(result.session.profileId);
    if (group) group.results.push(result);
    else groups.set(result.session.profileId, { profileId: result.session.profileId, results: [result] });
  }
  return [...groups.values()];
}
