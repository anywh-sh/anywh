// Plan mode's `present_choice` fallback marks a genuinely closed
// question inside its own response text (`>>>QUESTION: ... >>>END`, see
// relay/src/planChoiceMarker.ts for the format and why it exists instead of
// a real tool call). The relay parses that same block into a
// `choice_prompt` that renders as a proper `ChoiceCard` — this strips the
// raw marker out of the displayed message text so the human doesn't also
// see the sentinel syntax underneath the card.
//
// A still-streaming response can end mid-block, with `>>>QUESTION:` opened
// but no `>>>END` yet — since streamed text only ever grows, that partial
// block is always at the tail of what's arrived so far. Stripping it too
// (not just complete blocks) hides the raw sentinel from the very first
// token instead of flashing it until the close arrives.
const CLOSED_MARKER_REGEX = />>>QUESTION:[\s\S]*?>>>END\s*/g;
const TRAILING_OPEN_MARKER_REGEX = />>>QUESTION:[\s\S]*$/;

export function stripPlanChoiceMarkers(text: string): string {
  return text.replace(CLOSED_MARKER_REGEX, "").replace(TRAILING_OPEN_MARKER_REGEX, "").trimEnd();
}
