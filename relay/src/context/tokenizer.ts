// Lazily loads `gpt-tokenizer`'s per-encoding rank table — ~41 MB of RSS
// that has no `import()` eviction once loaded (journal/79 §4bis.3), so the
// only lever available is never calling this until a client actually opens
// the context breakdown popover. A relay that never gets asked never pays
// the memory.
//
// Verified against the real esbuild+SEA bundle (CJS, `bundle: true`,
// `platform: "node"` — same config `sea-build/build.mjs` uses): a dynamic
// `import()` inside a function stays lazy after bundling, it is not hoisted
// to a static `require` at module load. Measured directly: RSS stayed flat
// across boot and up to the first call, then jumped by the full rank-table
// size only once the encoder was actually used (journal/79's own E1).
//
// Both import specifiers are string literals, not a template built from
// `encoding` — a dynamic package-export path (`gpt-tokenizer/encoding/${x}`)
// isn't something esbuild can resolve against `node_modules`'s exports map,
// only a literal one. The ternary still evaluates (and therefore imports)
// only the branch actually taken.
export type ContextEncoding = "cl100k_base" | "o200k_base";

interface TokenizerModule {
  countTokens(text: string): number;
}

const encoders = new Map<ContextEncoding, Promise<TokenizerModule>>();

function loadEncoder(encoding: ContextEncoding): Promise<TokenizerModule> {
  const cached = encoders.get(encoding);
  if (cached) return cached;
  const promise: Promise<TokenizerModule> =
    encoding === "cl100k_base" ? import("gpt-tokenizer/encoding/cl100k_base") : import("gpt-tokenizer/encoding/o200k_base");
  encoders.set(encoding, promise);
  return promise;
}

export async function countTokens(text: string, encoding: ContextEncoding): Promise<number> {
  const encoder = await loadEncoder(encoding);
  return encoder.countTokens(text);
}
