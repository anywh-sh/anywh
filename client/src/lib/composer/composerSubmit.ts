import { parseSlashCommand, suggestSlashCommand } from "@/lib/composer/slashCommands";
import type { ModelCatalog } from "@/lib/relay/relayClient";
import type { EffortChoices } from "@/lib/composer/effortCatalog";

export type SubmitDecision =
  | { kind: "empty" }
  | { kind: "typo"; suggestion: string }
  | { kind: "send" };

/**
 * What the composer should do with the text the user just submitted.
 *
 * `text` is the already-trimmed plain text. `confirmedTypoText` is the text of
 * a typo banner that is already on screen: submitting that exact text again
 * means the user is reconfirming (second Enter, or "send anyway"), so only a
 * *new* typo-shaped text blocks the send, not the one already surfaced.
 */
export function decideSubmit(input: {
  text: string;
  attachmentCount: number;
  confirmedTypoText: string | null;
  catalog: ModelCatalog | null;
  efforts?: EffortChoices | null;
}): SubmitDecision {
  const { text, attachmentCount, confirmedTypoText, catalog, efforts = null } = input;
  if (!text && attachmentCount === 0) return { kind: "empty" };
  if (confirmedTypoText !== text) {
    const suggestion = parseSlashCommand(text, catalog, efforts) === null ? suggestSlashCommand(text) : null;
    if (suggestion) return { kind: "typo", suggestion };
  }
  return { kind: "send" };
}
