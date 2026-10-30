// What the composer accepts as an attachment, decided by the file's
// extension rather than its MIME type: a `.md` or a source file usually
// arrives with an empty `type` (and a dropped file only ever gets the one
// `mimeTypes.ts` guesses), so the MIME type can't tell text from junk.

export type AttachmentKind = "image" | "video" | "file";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "svg"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "avi", "mkv"];
/** Files the agent reads as they are (`Read` handles text and PDF). */
const FILE_EXTENSIONS = [
  // text and docs
  "txt", "md", "markdown", "mdx", "rst", "log", "pdf",
  // data and config
  "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "ini", "xml",
  // code
  "html", "htm", "css", "scss", "sass", "less",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "scala", "dart",
  "c", "h", "cc", "cpp", "hpp", "cs", "m", "mm",
  "php", "lua", "r", "ex", "exs", "erl", "hs", "ml", "clj",
  "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "gql", "proto", "tf", "hcl", "gradle",
  "diff", "patch",
];
/** Plain-text files that conventionally carry no extension at all. */
const EXTENSIONLESS_NAMES = new Set([
  "makefile", "dockerfile", "containerfile", "gemfile", "rakefile", "procfile", "justfile",
  "license", "readme", "changelog", "codeowners",
]);

const KIND_BY_EXTENSION = new Map<string, AttachmentKind>([
  ...IMAGE_EXTENSIONS.map((ext) => [ext, "image"] as const),
  ...VIDEO_EXTENSIONS.map((ext) => [ext, "video"] as const),
  ...FILE_EXTENSIONS.map((ext) => [ext, "file"] as const),
]);

/** Lowercased extension of a filename, or `null` when it has none (a
 * leading dot alone, as in `.gitignore`, doesn't count). */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** The kind a file is attached as, or `null` when the composer refuses it. */
export function attachmentKindFor(file: Pick<File, "name" | "type">): AttachmentKind | null {
  const ext = fileExtension(file.name);
  if (ext !== null) {
    const kind = KIND_BY_EXTENSION.get(ext);
    if (kind) return kind;
  } else if (EXTENSIONLESS_NAMES.has(file.name.toLowerCase())) {
    return "file";
  }
  // A pasted screenshot can come with no usable name at all; its MIME type
  // is still trustworthy for images and video.
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/svg+xml": "svg", "video/quicktime": "mov" };

/** The extension the relay saves an accepted file under: its own when it has
 * one, the media type's for a nameless image/video, and `txt` for the
 * extensionless text names above. */
export function uploadExtension(file: Pick<File, "name" | "type">): string {
  const ext = fileExtension(file.name);
  if (ext !== null) return ext;
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
    return EXTENSION_BY_MEDIA_TYPE[file.type] ?? file.type.split("/")[1] ?? "bin";
  }
  return "txt";
}

/** The file input's `accept`: every extension above plus the media wildcards. */
export const ATTACHMENT_ACCEPT = ["image/*", "video/*", ...FILE_EXTENSIONS.map((ext) => `.${ext}`)].join(",");
