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

function splitLines(value: string): MdNode[] {
  const nodes: MdNode[] = [];
  value.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push({ type: "break" });
    if (line) nodes.push({ type: "text", value: line });
  });
  return nodes;
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
    if (child.type === "text" && child.value?.includes("\n")) return splitLines(child.value);
    transform(child, source);
    return [child];
  });
}

/** Remark plugin for a message the user typed (the chat's user bubble):
 * markdown still renders — emphasis, lists, code, links, tables — but every
 * newline is kept, headings and rules stay literal text and raw HTML is
 * shown escaped. */
export function remarkUserMessage() {
  return (tree: MdNode, file: { value: unknown }) => {
    transform(tree, String(file.value));
  };
}
