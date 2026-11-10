/** The slice of an mdast node this plugin reads and writes — structural, like
 * `remarkUserMessage`'s, so it needs no direct dependency on `@types/mdast`. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

/** The hast property a chip's `<span>` carries its key in; React gets it as
 * `data-ticket-chip`. */
export const TICKET_CHIP_ATTRIBUTE = "data-ticket-chip";

/** Text a chip never goes in: code shows what was typed, a link is already one. */
const SKIPPED = new Set(["inlineCode", "code", "link", "linkReference", "html"]);

const KEY_CHAR = /[A-Za-z0-9-]/;

/** Where `key` first stands in `text` as a whole key (`NGL-12` is not in
 * `NGL-123`) from `from` on, or -1. */
function keyIndex(text: string, key: string, from = 0): number {
  for (let at = text.indexOf(key, from); at !== -1; at = text.indexOf(key, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + key.length] ?? "";
    if (!KEY_CHAR.test(before) && !KEY_CHAR.test(after)) return at;
  }
  return -1;
}

/** Whether `key` stands in `text` as a whole key. Pure. */
export function textHasTicketKey(text: string, key: string): boolean {
  return keyIndex(text, key) !== -1;
}

function chipNode(key: string): MdNode {
  return { type: "ticketChip", data: { hName: "span", hProperties: { dataTicketChip: key } }, children: [{ type: "text", value: key }] };
}

/** `value` cut at the first whole occurrence of each key still in `left`
 * (which it takes them out of), with a chip in their place. */
function splitText(value: string, left: Set<string>): MdNode[] {
  const nodes: MdNode[] = [];
  let rest = value;
  for (;;) {
    let first: { at: number; key: string } | undefined;
    for (const key of left) {
      const at = keyIndex(rest, key);
      if (at !== -1 && (!first || at < first.at)) first = { at, key };
    }
    if (!first) break;
    if (first.at > 0) nodes.push({ type: "text", value: rest.slice(0, first.at) });
    nodes.push(chipNode(first.key));
    left.delete(first.key);
    rest = rest.slice(first.at + first.key.length);
  }
  if (rest) nodes.push({ type: "text", value: rest });
  return nodes;
}

function transform(node: MdNode, left: Set<string>): void {
  if (!node.children || left.size === 0) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (left.size === 0 || SKIPPED.has(child.type)) return [child];
    if (child.type === "text") return splitText(child.value ?? "", left);
    transform(child, left);
    return [child];
  });
}

/** Remark plugin for a user bubble: the first whole occurrence of each of
 * `keys` — the tickets the person put in the message as `#` chips, never a
 * key found in the text on its own — becomes a `<span data-ticket-chip>`
 * that `MarkdownContent` draws as the chip. Runs after `remarkUserMessage`. */
export function remarkTicketChips(options: { keys: readonly string[] }) {
  return (tree: MdNode) => {
    transform(tree, new Set(options.keys));
  };
}
