import { useEffect, useState } from "react";
import type { ChangeSignal } from "@/components/files/FilesPanel";
import { fetchRawFile, readFile, rawFileUrl, type FileReadResult } from "@/lib/relay/filesClient";
import { isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { CodeFileView } from "@/components/files/CodeFileView";
import { useDict } from "@/i18n";
import { MarkdownFileView } from "@/components/files/MarkdownFileView";

interface FileViewerProps {
  profile: Profile;
  sessionId: string;
  path: string;
  /** Watch reported a change to this exact path — silently
   * refetches in place (no "loading…" flash) rather than the initial fetch
   * below; the scroll position is preserved since nothing unmounts. */
  changedFile: ChangeSignal | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A direct-mode profile's `host`/`relayPort` are real, dialable — a plain
 * `<img src>` works as-is, at zero extra cost (native browser caching and
 * progressive decode, no JS in the loop). A tailnet profile's connect token
 * is single-use per connection, which a bare image tag has
 * no way to attach, so that case instead fetches the bytes with the right
 * header and swaps in an object URL — same raw bytes, no re-encoding, so no
 * quality loss, just paid only by the profiles that actually need it.
 */
function RawImage({
  profile,
  sessionId,
  path,
  mtimeMs,
  alt,
}: {
  profile: Profile;
  sessionId: string;
  path: string;
  mtimeMs: number;
  alt: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isTailnetProfile(profile)) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchRawFile(profile, sessionId, path, mtimeMs)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to fetch raw image over the tailnet tunnel:", error);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [profile, sessionId, path, mtimeMs]);

  const src = isTailnetProfile(profile) ? blobUrl : rawFileUrl(profile, sessionId, path, mtimeMs);
  if (!src) return null;
  return <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />;
}

/**
 * Fetches and routes a single open file to the right renderer, by `kind`:
 * image and binary are simple placeholders, `.md` gets the
 * formatted/raw toggle (`MarkdownFileView`), anything else is plain code
 * (`CodeFileView`). One instance per active tab — `key={path}` at the call
 * site (`FilesPanel`) resets all local state (including the markdown
 * toggle) when switching files, instead of carrying it over.
 */
export function FileViewer({ profile, sessionId, path, changedFile }: FileViewerProps) {
  const copy = useDict().panels.files.viewer;
  const [result, setResult] = useState<FileReadResult | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setResult("loading");
    readFile(profile, sessionId, path)
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch(() => {
        if (!cancelled) setResult("error");
      });
    return () => {
      cancelled = true;
    };
  }, [profile, sessionId, path]);

  useEffect(() => {
    if (!changedFile || changedFile.path !== path) return;
    let cancelled = false;
    readFile(profile, sessionId, path)
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch(() => {
        // The agent deleted the file while its tab was still open — reflect
        // that instead of silently keeping the stale content on screen.
        if (!cancelled) setResult("error");
      });
    return () => {
      cancelled = true;
    };
  }, [changedFile, path, profile, sessionId]);

  if (result === "loading") {
    return <div className="flex h-full items-center justify-center font-mono text-[11px] text-muted-foreground">{copy.loading}</div>;
  }
  if (result === "error") {
    return <div className="flex h-full items-center justify-center font-mono text-[11px] text-destructive">{copy.failed}</div>;
  }

  if (result.kind === "image") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-4">
        <RawImage profile={profile} sessionId={sessionId} path={result.path} mtimeMs={result.mtimeMs} alt={path} />
        <span className="font-mono text-[11px] text-text-faint">{formatBytes(result.size)}</span>
      </div>
    );
  }

  if (result.kind === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 font-mono text-[11px] text-muted-foreground">
        <span>{copy.binary}</span>
        <span className="text-text-faint">{formatBytes(result.size)}</span>
      </div>
    );
  }

  if (path.toLowerCase().endsWith(".md")) {
    return <MarkdownFileView path={result.path} content={result.content} truncated={result.truncated} />;
  }

  return (
    <div className="flex h-full flex-col">
      {result.truncated && (
        <div className="shrink-0 border-b border-border-soft bg-bg-elevated px-3 py-1 font-mono text-[10.5px] text-muted-foreground">{copy.truncated}</div>
      )}
      <div className="min-h-0 flex-1">
        <CodeFileView path={result.path} content={result.content} />
      </div>
    </div>
  );
}
