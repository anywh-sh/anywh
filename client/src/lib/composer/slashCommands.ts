import { getKnownModels, labelForModel } from "@/lib/composer/modelCatalog";
import type { Dictionary } from "@/i18n/dictionary";
import type { ModelChoice } from "@/lib/relay/relay-types";

export type SlashCommand = { name: "model"; model: ModelChoice } | { name: "clear" };

/**
 * `/model` and `/clear` typed in the composer — recognized here
 * BEFORE becoming a real turn, because neither can be a pure passthrough to
 * `claude -p`: a typed `/model` only applies "to this ephemeral process"
 * (confirmed by testing the binary — the next turn goes back to the old
 * model), and we decided to resolve `/clear` locally on the relay instead of
 * spending a turn asking the CLI to do it (see
 * sharedSession.ts::clearConversation).
 *
 * `null` covers two cases that should fall back to a normal message send:
 * plain text, OR a recognized command with an argument we don't curate
 * (e.g. `/model gpt4`) — in this second case the text passes through as a
 * normal message and the CLI itself responds with its own error, without us
 * needing to duplicate validation/error messages here.
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();

  if (/^\/clear$/i.test(trimmed)) return { name: "clear" };

  const modelMatch = /^\/model\s+(\S+)$/i.exec(trimmed);
  if (modelMatch) {
    const model = modelMatch[1].toLowerCase();
    if (model === "default" || getKnownModels().includes(model)) return { name: "model", model };
  }

  return null;
}

/** Base command keywords `suggestSlashCommand` typo-corrects against — just
 * the two names `parseSlashCommand` recognizes, not the model catalog: a
 * near-miss on `/model`'s *argument* (`/model gpt4`) is meant to fall through
 * to the CLI's own error (see `parseSlashCommand`'s doc comment), only the
 * keyword itself is worth flagging before it silently becomes a chat
 * message. */
const KNOWN_COMMAND_KEYWORDS = ["clear", "model"];

/** Classic Levenshtein (single-character insert/delete/substitute), no
 * transposition — plain substitution already gives adjacent-swap typos
 * (`modle` vs `model`) a distance of 2, which the caller's threshold already
 * covers, so the extra complexity of Damerau-Levenshtein isn't earning its
 * keep here. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) distances[i][0] = i;
  for (let j = 0; j < cols; j++) distances[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + cost,
      );
    }
  }
  return distances[rows - 1][cols - 1];
}

/**
 * Typo-correction for text that reads as an *attempted* command but doesn't
 * parse as one — `/cler` (missing letter), `/modle opus` (transposition) —
 * distinct from `parseSlashCommand`'s `null`, which also covers plain text
 * that merely starts a line with `/` (a file path like `/etc/passwd`, or a
 * date). Only the first "word" after the slash is compared against the known
 * keywords (`KNOWN_COMMAND_KEYWORDS`); the CLI/`/model` argument, if any, is
 * carried through unchanged into the suggested replacement.
 *
 * Returns `null` for: an exact match (already handled by
 * `parseSlashCommand`), text that isn't slash-command-shaped at all, or a
 * typed word too far from every known keyword to be a plausible typo — the
 * threshold (max 2 edits, scaled down for short words) is deliberately tight
 * to avoid flagging an unrelated short path segment (`/src/...`) or English
 * word (`/close`) as a typo of a command nobody was trying to type.
 */
export function suggestSlashCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1);
  const boundary = withoutSlash.search(/\s/);
  const typedWord = (boundary === -1 ? withoutSlash : withoutSlash.slice(0, boundary)).toLowerCase();
  const rest = boundary === -1 ? "" : withoutSlash.slice(boundary);
  if (!typedWord) return null;

  let best: { keyword: string; distance: number } | null = null;
  for (const keyword of KNOWN_COMMAND_KEYWORDS) {
    if (typedWord === keyword) return null;
    const distance = levenshteinDistance(typedWord, keyword);
    const threshold = keyword.length <= 4 ? 1 : 2;
    if (distance <= threshold && (!best || distance < best.distance)) best = { keyword, distance };
  }
  return best ? `/${best.keyword}${rest}` : null;
}

export interface SlashCommandEntry {
  /** Full text that fills the composer on selection — includes the slash. */
  command: string;
  description: string;
}

/** The composer slice as a whole, not just `commands`: a model entry needs
 * both its blurb and the label of the model it names. */
type CommandCopy = Dictionary["chat"]["composer"];

/** Blurbs for the aliases we know about, straight from the dictionary — any
 * other choice (a new alias the CLI ships later) falls back to a generic
 * "Uses X" built from `labelForModel`, so a new model shows up in the menu
 * without a copy change in two languages. */
function descriptionFor(choice: string, copy: CommandCopy): string {
  if (choice === "default") return copy.commands.modelDefault;
  if (choice === "opus") return copy.commands.modelOpus;
  if (choice === "haiku") return copy.commands.modelHaiku;
  return copy.commands.modelGeneric.replace("{model}", labelForModel(choice, copy.modelAliases));
}

/** Catalog for the autocomplete menu (SlashCommandMenu) — one entry per
 * combination already ready to send (including each model the CLI reports
 * as available), not just the two command names. Discovering "which models
 * exist" via free typing would be worse UX than already listing all of them
 * ready to go. Computed on every call (not a static list) since the model
 * catalog itself is dynamic (`@/lib/composer/modelCatalog`) and the copy follows the
 * selected language. */
function getSlashCommandEntries(copy: CommandCopy): SlashCommandEntry[] {
  return [
    { command: "/clear", description: copy.commands.clear },
    { command: "/model default", description: descriptionFor("default", copy) },
    ...getKnownModels().map((choice) => ({ command: `/model ${choice}`, description: descriptionFor(choice, copy) })),
  ];
}

/** Filters by substring (case-insensitive) against the command's text
 * (without the slash) or its description — covers both "typed the name" and
 * "typed what it does". Empty query returns the whole catalog, in the order
 * declared. The copy arrives as an argument rather than being read from a
 * hook: this runs inside Tiptap's `Suggestion`, outside React's render
 * cycle (see `Composer.tsx`). */
export function filterSlashCommands(query: string, copy: CommandCopy): SlashCommandEntry[] {
  const entries = getSlashCommandEntries(copy);
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (entry) => entry.command.slice(1).toLowerCase().includes(q) || entry.description.toLowerCase().includes(q),
  );
}
