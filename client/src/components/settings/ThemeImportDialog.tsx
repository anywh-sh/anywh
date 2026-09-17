import { useEffect, useRef, useState } from "react";
import { Copy, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDict, type Dictionary } from "@/i18n";
import { Textarea } from "@/components/ui/input";
import type { Profile } from "@/lib/profiles/profiles";
import { parseTheme, type Theme, type ThemeValidationError } from "@/lib/theme/theme";
import { saveTheme, ThemeSaveError } from "@/lib/relay/relayClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { setThemesForHost, customThemesForHost, themeStoreKey } from "@/lib/theme/themes";

/** Mirrors the relay's own cap (MAX_JSON_BODY_BYTES) so an oversized file
 * gets a readable message here instead of a dropped connection there. */
const MAX_THEME_BYTES = 64 * 1024;

/** One line of the error list: a sentence, plus the dotted path it belongs to
 * (empty for a failure that isn't about a particular field). */
interface ErrorRow {
  path: string;
  text: string;
}

interface ThemeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose host receives the theme — the registry is per machine. */
  profile: Profile;
  /** Pre-filled JSON, for editing an existing theme or duplicating one —
   * the realistic way to author a theme is to start from one that works. */
  initialJson?: string;
  /** Only changes the wording. Editing and creating are the same request:
   * saving under an existing id overwrites that theme, saving under a new
   * one creates a second. */
  intent?: ThemeDialogIntent;
  onImported: (theme: Theme) => void;
}

export type ThemeDialogIntent = "import" | "edit" | "duplicate";

/** Title, submit verb and hint, per intent. Editing borrows the plain
 * "save" verb from `common`, which is exactly what it does. */
function copyFor(intent: ThemeDialogIntent, dict: Dictionary): { title: string; submit: string; hint: string } {
  const copy = dict.settings.appearance.theme.import;
  switch (intent) {
    case "import":
      return { title: copy.importTitle, submit: copy.importSubmit, hint: copy.importHint };
    case "edit":
      return { title: copy.editTitle, submit: dict.common.save, hint: copy.editHint };
    case "duplicate":
      return { title: copy.duplicateTitle, submit: copy.duplicateSubmit, hint: copy.duplicateHint };
  }
}

/**
 * Import by pasting JSON or picking a file. `<input type="file">` rather
 * than a native dialog plugin: it already works in all three webviews (the
 * composer's image picker uses it), and adding tauri-plugin-dialog would
 * cost a capability entry per platform for no gain here.
 *
 * Validation runs locally first so a broken file is explained without a
 * round trip; the relay validates again and its errors land in the same
 * list, since it's the side that writes the file.
 */
export function ThemeImportDialog({
  open,
  onOpenChange,
  profile,
  initialJson,
  intent = "import",
  onImported,
}: ThemeImportDialogProps) {
  const dict = useDict();
  const copy = copyFor(intent, dict);
  const strings = dict.settings.appearance.theme.import;
  const [json, setJson] = useState(initialJson ?? "");
  const [errors, setErrors] = useState<ErrorRow[]>([]);

  /** A validation error resolved to a sentence, next to the path it belongs
   * to. The two non-validation failures (unparseable JSON, a network or
   * filesystem error from the relay) arrive as a sentence already and get an
   * empty path, which is what the list renders without a prefix. */
  function describe(error: ThemeValidationError): ErrorRow {
    const text = strings.validation[error.code];
    switch (error.code) {
      case "wrong_version":
        return { path: error.path, text: text.replace("{expected}", String(error.expected)) };
      case "invalid_id":
      case "invalid_name":
        return { path: error.path, text: text.replace("{maxLength}", String(error.maxLength)) };
      case "reserved_id":
        return { path: error.path, text: text.replace("{id}", error.id) };
      case "missing_colors":
        return { path: error.path, text: text.replace("{missing}", error.missing.join(", ")) };
      default:
        return { path: error.path, text };
    }
  }
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setJson(initialJson ?? "");
    setErrors([]);
    setSaving(false);
    setCopied(false);
  }, [open, initialJson]);

  async function handleFile(file: File): Promise<void> {
    if (file.size > MAX_THEME_BYTES) {
      setErrors([{ path: "", text: strings.tooLarge }]);
      return;
    }
    setJson(await file.text());
    setErrors([]);
  }

  async function handleSubmit(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      setErrors([{ path: "", text: error instanceof Error ? error.message : strings.invalidJson }]);
      return;
    }

    const result = parseTheme(parsed);
    if (!result.ok) {
      setErrors(result.errors.map(describe));
      return;
    }

    setSaving(true);
    try {
      const { host, port, token } = await resolveConnection(profile);
      const saved = await saveTheme(host, port, result.theme, token);
      // Optimistic: the next `useThemeSync` pass would pick this up anyway,
      // but that's on foreground/mount, and the theme has to be selectable
      // the moment the dialog closes.
      const key = themeStoreKey(profile);
      const current = customThemesForHost(key).filter((theme) => theme.id !== saved.id);
      setThemesForHost(key, [...current, saved]);
      onImported(saved);
      onOpenChange(false);
    } catch (error) {
      setErrors(
        error instanceof ThemeSaveError && error.errors.length > 0
          ? error.errors.map(describe)
          : [{ path: "", text: error instanceof Error ? error.message : String(error) }],
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <p className="text-xs text-muted-foreground">
            {copy.hint} {strings.hostHint.replace("{host}", profile.host)}
          </p>

          <Textarea
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              setErrors([]);
              setCopied(false);
            }}
            spellCheck={false}
            placeholder={'{\n  "version": 1,\n  "id": "meu-tema",\n  "name": "Meu tema",\n  "appearance": "dark",\n  "colors": { "background": "#1e1e1e", … }\n}'}
            className="h-56 w-full"
          />

          {errors.length > 0 && (
            <ul className="flex flex-col gap-1 border border-destructive/40 p-2.5">
              {errors.map((error, index) => (
                <li key={`${error.path}-${String(index)}`} className="text-xs text-destructive">
                  {error.path ? <span className="font-mono">{error.path}: </span> : null}
                  {error.text}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleFile(file);
              }}
            />
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-3.5" />
                {strings.chooseFile}
              </Button>
              {/* Doubles as the export path: opening this dialog from
                  "duplicar" pre-fills it with the whole theme. Clipboard
                  instead of a download link — `download` on an anchor isn't
                  honored across all three webviews, and copying is the
                  gesture that works the same on desktop and on the phone. */}
              <Button
                variant="ghost"
                size="sm"
                disabled={json.trim().length === 0}
                onClick={() => {
                  navigator.clipboard.writeText(json).then(
                    () => setCopied(true),
                    () => setErrors([{ path: "", text: strings.copyFailed }]),
                  );
                }}
              >
                <Copy className="size-3.5" />
                {copied ? strings.copied : dict.common.copy}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {dict.common.cancel}
              </Button>
              <Button size="sm" disabled={saving || json.trim().length === 0} onClick={() => void handleSubmit()}>
                {saving ? strings.saving : copy.submit}
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
