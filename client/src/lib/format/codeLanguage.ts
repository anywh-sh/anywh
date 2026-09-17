// Extension → language name map registered in lowlight's "common" bundle
// (see `highlightCode.tsx`) — used to color Edit/Write content in
// `ToolCallCard` according to the file being touched.
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  html: "xml",
  htm: "xml",
  md: "markdown",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  pl: "perl",
  r: "r",
};

export function languageForPath(path: string | undefined): string {
  if (!path) return "plaintext";
  const base = path.split("/").pop() ?? path;
  if (base.toLowerCase() === "makefile") return "makefile";
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) return "plaintext";
  const ext = base.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? "plaintext";
}
