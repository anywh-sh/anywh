/** The slice of an mdast node this plugin reads — structural, so it needs no
 * direct dependency on `@types/mdast`. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Constructs whose markdown meaning a user rarely intends, and that a pasted
 * log or stack trace trips over all the time: `# comment` lines, a line
 * underlined with `===`/`---` (setext), a lone `---`. They render as the
 * literal source they came from. */
const LITERAL_BLOCKS = new Set(["heading", "thematicBreak"]);

/** Nodes whose children are blocks, where loose inline text can't sit. */
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);

/** A line break the user typed. Not mdast's own `break`: `remark-rehype`
 * strips the leading whitespace of the text after one of those, which is
 * the indentation this plugin keeps. `USER_MESSAGE_REHYPE_OPTIONS` turns it
 * into a `<br>`. */
const TYPED_BREAK = "typedBreak";

function splitLines(value: string): MdNode[] {
  const nodes: MdNode[] = [];
  value.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push({ type: TYPED_BREAK });
    if (line) nodes.push({ type: "text", value: line });
  });
  return nodes;
}

/** A paragraph's text as typed: the parser strips each continuation line's
 * leading whitespace, which is the indentation of a pasted stack trace or
 * snippet. Taken back from the source when that strip is the only
 * difference — escapes, entities or a blockquote's `>` prefix make the
 * source differ for real, and the parsed value is kept. */
function typedText(node: MdNode, source: string): string {
  const value = node.value ?? "";
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return value;
  const raw = source.slice(start, end).replace(/[ \t]+\n/g, "\n");
  return raw.replace(/\n[ \t]+/g, "\n") === value ? raw : value;
}

function transform(node: MdNode, source: string): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (LITERAL_BLOCKS.has(child.type)) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const literal = start === undefined || end === undefined ? "" : source.slice(start, end);
      return [{ type: "paragraph", children: splitLines(literal) }];
    }
    // Raw HTML shows as the text the user typed, never as markup — wrapped
    // in a paragraph when it stood as a block of its own.
    if (child.type === "html") {
      const inline = splitLines(child.value ?? "");
      return BLOCK_PARENTS.has(node.type) ? [{ type: "paragraph", children: inline }] : inline;
    }
    // A single newline is a line break the user meant, not a soft wrap.
    if (child.type === "text" && child.value?.includes("\n")) return splitLines(typedText(child, source));
    transform(child, source);
    return [child];
  });
}

/** Remark plugin for a message the user typed (the chat's user bubble):
 * markdown still renders — emphasis, lists, code, links, tables — but every
 * newline is kept along with the indentation after it, headings and rules
 * stay literal text and raw HTML is shown escaped. The bubble's CSS
 * (`.prose-chat-user p`) keeps those spaces from collapsing, and
 * `USER_MESSAGE_REHYPE_OPTIONS` keeps each break from adding a second one. */
export function remarkUserMessage() {
  return (tree: MdNode, file: { value: unknown }) => {
    transform(tree, String(file.value));
  };
}

/** `remark-rehype` options for the same messages: a break — typed, or a
 * markdown hard break — becomes a bare `<br>`, without the `\n` text node the
 * default handler emits after it; under `white-space: pre-wrap` that newline
 * would be a second line break. */
const bareBreak = () => ({ type: "element" as const, tagName: "br", properties: {}, children: [] });
export const USER_MESSAGE_REHYPE_OPTIONS = {
  handlers: { break: bareBreak, [TYPED_BREAK]: bareBreak },
};
