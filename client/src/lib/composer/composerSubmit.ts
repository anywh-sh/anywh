import { parseSlashCommand, suggestSlashCommand } from "@/lib/composer/slashCommands";
import type { ModelCatalog } from "@/lib/relay/relayClient";

export type SubmitDecision =
  | { kind: "empty" }
  | { kind: "uploading" }
  | { kind: "typo"; suggestion: string }
  | { kind: "send" };

/**
 * What the composer should do with the text the user just submitted.
 *
 * `text` is the already-trimmed plain text. `confirmedTypoText` is the text of
 * a typo banner that is already on screen: submitting that exact text again
 * means the user is reconfirming (second Enter, or "send anyway"), so only a
 * *new* typo-shaped text blocks the send, not the one already surfaced.
 *
 * `uploading` holds the send while an attachment is still on its way to the
 * relay — otherwise the message goes out without it, and the file lands in
 * the pending list of the *next* message instead.
 */
export function decideSubmit(input: {
  text: string;
  attachmentCount: number;
  uploading: boolean;
  confirmedTypoText: string | null;
  catalog: ModelCatalog | null;
}): SubmitDecision {
  const { text, attachmentCount, uploading, confirmedTypoText, catalog } = input;
  if (!text && attachmentCount === 0 && !uploading) return { kind: "empty" };
  if (uploading) return { kind: "uploading" };
  if (confirmedTypoText !== text) {
    const suggestion = parseSlashCommand(text, catalog) === null ? suggestSlashCommand(text) : null;
    if (suggestion) return { kind: "typo", suggestion };
  }
  return { kind: "send" };
}
