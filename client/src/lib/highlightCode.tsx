import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { createLowlight, common } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ElementContent, RootContent } from "hast";

// Same engine (lowlight/hast, on top of highlight.js) that `AssistantText`
// already uses via `rehype-highlight` for markdown code blocks — reuses the
// `.hljs-*` theme from `index.css`, without needing to go through the
// markdown parser (here the input is a diff/file's raw content, not the
// agent's text).
const lowlight = createLowlight(common);

/** Splits a hast node's content into one array of nodes per source line,
 * re-wrapping any element that spans a line break (e.g. a `.hljs-comment`
 * span around a multi-line `/* ... *\/` block) so each line gets its own
 * clone carrying the same tag/properties. Without this, tokenizing each
 * line's text in isolation would lose the "still inside a block comment"
 * state and the middle lines of the comment would render unhighlighted. */
function splitByLine(nodes: RootContent[]): ElementContent[][] {
  const lines: ElementContent[][] = [[]];

  for (const node of nodes) {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      parts.forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part.length > 0) {
          lines[lines.length - 1].push({ type: "text", value: part });
        }
      });
    } else if (node.type === "element") {
      const childLines = splitByLine(node.children);
      childLines.forEach((children, index) => {
        if (index > 0) lines.push([]);
        if (children.length > 0) {
          lines[lines.length - 1].push({
            type: "element",
            tagName: node.tagName,
            properties: node.properties,
            children,
          });
        }
      });
    }
    // lowlight's output is always `text`/`element` — nothing else to handle.
  }

  return lines;
}

/** Colors a list of code lines (already split, e.g. one per diff row)
 * according to the detected language (see `codeLanguage.ts`). Highlights
 * the lines as a single block — instead of one call per line — so the
 * tokenizer's state (inside a block comment, a string, ...) carries across
 * line breaks; the result is then split back into one `ReactNode` per input
 * line. Falls back to plain text if the language isn't recognized or the
 * parser fails on a malformed snippet — highlighting is cosmetic, it can
 * never break the card's rendering. */
export function highlightLines(language: string, lines: string[]): ReactNode[] {
  const lang = lowlight.registered(language) ? language : "plaintext";
  try {
    const tree = lowlight.highlight(lang, lines.join("\n"));
    const splitLines = splitByLine(tree.children);
    return lines.map((_, index) => {
      const children = splitLines[index] ?? [];
      return toJsxRuntime({ type: "root", children }, { Fragment, jsx, jsxs });
    });
  } catch {
    return lines;
  }
}
