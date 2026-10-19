import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { highlightLines } from "@/lib/format/highlightCode";
import { useDict } from "@/i18n";

/** Past this many characters the display stops: the highlighter and the DOM
 * both pay per character, and nobody reads a megabyte of JSON in a chat. The
 * copy button still hands over the whole thing. */
export const MAX_DISPLAY_CHARS = 30_000;

/** Height in px past which a block is clipped behind "Show all". */
const DEFAULT_CAP = 220;

/** What a block shows for a value: objects pretty-printed, strings that parse
 * as JSON pretty-printed too, anything else verbatim. */
export function toDisplayText(value: unknown): { text: string; json: boolean } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
      } catch {
        // Not JSON after all — falls through to the plain string.
      }
    }
    return { text: value, json: false };
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? { text: String(value), json: false } : { text, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

const FADE = "linear-gradient(to bottom, currentColor calc(100% - 3rem), transparent)";

interface CodeBlockProps {
  label: string;
  value: unknown;
  copyLabel: string;
  onCopy: (text: string) => void;
  /** Height in px past which the block is clipped behind a fade. */
  cap?: number;
}

/**
 * One labelled, copyable block of a call's arguments or result. A long one
 * stops at `cap` with a fade and a "Show all" instead of stretching the
 * conversation, and a huge one is cut for display (see `MAX_DISPLAY_CHARS`).
 */
export function CodeBlock({ label, value, copyLabel, onCopy, cap = DEFAULT_CAP }: CodeBlockProps) {
  const dict = useDict().chat.activity;
  const { text, json } = useMemo(() => toDisplayText(value), [value]);
  // A string is copied as it arrived: pretty-printing re-serializes it, which
  // can round a large integer or drop a duplicate key — fine to read, wrong to
  // paste. Anything else has no original text, so the pretty form is the copy.
  const copyable = typeof value === "string" ? value : text;
  const omitted = Math.max(0, text.length - MAX_DISPLAY_CHARS);
  const shown = omitted > 0 ? text.slice(0, MAX_DISPLAY_CHARS) : text;
  const lines = useMemo(() => (json ? highlightLines("json", shown.split("\n")) : null), [json, shown]);

  const pre = useRef<HTMLPreElement>(null);
  const [natural, setNatural] = useState(0);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);

  // The natural height decides whether the cap applies at all; a block a few
  // px over it isn't worth a toggle, hence the slack.
  useLayoutEffect(() => {
    const el = pre.current;
    if (!el) return;
    const measure = () => setNatural(el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const capped = natural > cap + 24;
  const clipped = capped && !full;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-6 items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-text-faint uppercase">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? dict.resultCopied : copyLabel}
          title={copied ? dict.resultCopied : copyLabel}
          onClick={() => {
            onCopy(copyable);
            setCopied(true);
          }}
        >
          {copied ? <Check className="text-primary" /> : <Copy />}
        </Button>
      </div>
      <pre
        ref={pre}
        className={cn("selectable-content overflow-x-auto border border-border-soft bg-card px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre text-foreground", clipped && "overflow-y-hidden")}
        style={{
          ...(capped ? { maxHeight: full ? natural : cap } : {}),
          ...(clipped ? { maskImage: FADE, WebkitMaskImage: FADE } : {}),
        }}
      >
        <code>
          {lines
            ? lines.map((line, index) => (
                <span key={index} className="block">
                  {line}
                </span>
              ))
            : shown}
        </code>
      </pre>
      {omitted > 0 && <p className="font-mono text-[11px] text-text-faint">{dict.block.truncated.replace("{count}", omitted.toLocaleString())}</p>}
      {capped && (
        <button type="button" aria-expanded={full} onClick={() => setFull(!full)} className="cursor-pointer self-start font-mono text-[11px] text-text-faint transition-colors hover:text-foreground">
          {full ? dict.block.showLess : dict.block.showAll}
        </button>
      )}
    </div>
  );
}
