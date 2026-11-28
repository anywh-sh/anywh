import { chatMediaKind, localMediaPath } from "@/lib/media/chatMedia";

/** The slice of an mdast node this plugin reads — structural, like
 * `remarkUserMessage`'s, so it needs no direct dependency on `@types/mdast`. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** The hast property a gallery carries (`data-media-gallery`), which is how
 * `MarkdownContent`'s `div` override tells one from any other `div`. */
export const MEDIA_GALLERY_PROPERTY = "dataMediaGallery";

const GALLERY = "mediaGallery";

function isLocalMediaImage(node: MdNode): boolean {
  if (node.type !== "image") return false;
  const path = localMediaPath(node.url);
  return path !== undefined && chatMediaKind(path) !== undefined;
}

/** What may sit between two images of one run without breaking it: the
 * newline or spaces an agent writes between `![a](..)` and `![b](..)`. */
function isBlank(node: MdNode): boolean {
  return node.type === "break" || (node.type === "text" && (node.value ?? "").trim() === "");
}

function gallery(images: MdNode[]): MdNode {
  return { type: GALLERY, data: { hName: "div", hProperties: { [MEDIA_GALLERY_PROPERTY]: "" } }, children: images };
}

/** A paragraph's own text, without the blank edges a split leaves behind
 * (the line break that separated it from the images). */
function trimmedParagraph(children: MdNode[]): MdNode | undefined {
  let start = 0;
  let end = children.length;
  while (start < end && isBlank(children[start])) start++;
  while (end > start && isBlank(children[end - 1])) end--;
  if (start === end) return undefined;
  const kept = children.slice(start, end).map((node) => ({ ...node }));
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (first.type === "text") first.value = (first.value ?? "").replace(/^\s+/, "");
  if (last.type === "text") last.value = (last.value ?? "").replace(/\s+$/, "");
  return { type: "paragraph", children: kept };
}

/**
 * A paragraph holding images, split into the text around them and the runs
 * of images themselves — `Screenshots:\n![a](..)\n![b](..)` is one paragraph
 * to the parser, but reads as a line of text and then a gallery. `undefined`
 * when it holds no local media image and stays as it is.
 */
function splitParagraph(paragraph: MdNode): MdNode[] | undefined {
  const children = paragraph.children ?? [];
  if (!children.some(isLocalMediaImage)) return undefined;

  const out: MdNode[] = [];
  let text: MdNode[] = [];
  let images: MdNode[] = [];
  const flushText = (): void => {
    const node = trimmedParagraph(text);
    if (node) out.push(node);
    text = [];
  };
  const flushImages = (): void => {
    if (images.length > 0) out.push(gallery(images));
    images = [];
  };

  for (const child of children) {
    if (isLocalMediaImage(child)) {
      if (images.length === 0) flushText();
      images.push(child);
    } else if (images.length > 0 && isBlank(child)) {
      // Between two images it's dropped; before text it's that text's edge,
      // which `trimmedParagraph` drops anyway.
      continue;
    } else {
      flushImages();
      text.push(child);
    }
  }
  flushImages();
  flushText();
  return out;
}

function transform(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    const split = child.type === "paragraph" ? splitParagraph(child) : undefined;
    for (const part of split ?? [child]) {
      const previous = next[next.length - 1];
      // Images only blank lines apart are still one gallery.
      if (part.type === GALLERY && previous?.type === GALLERY) {
        previous.children = [...(previous.children ?? []), ...(part.children ?? [])];
      } else {
        next.push(part);
      }
    }
    if (!split) transform(child);
  }
  node.children = next;
}

/**
 * Remark plugin: lifts the local images and videos of a message out of their
 * paragraphs into galleries — runs of them, separated by nothing but line
 * breaks or blank lines, become one `div[data-media-gallery]` that
 * `MarkdownContent` renders as `MediaGallery`. An image of a remote URL is
 * left inline: it never becomes a tile (`MarkdownImage` shows it as a link).
 */
export function remarkMediaGallery() {
  return (tree: MdNode): void => transform(tree);
}
