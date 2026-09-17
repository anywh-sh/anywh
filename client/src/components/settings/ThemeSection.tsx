import { useState } from "react";
import { Check, MoreHorizontal, Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeImportDialog, type ThemeDialogIntent } from "@/components/settings/ThemeImportDialog";
import { useThemeCatalog, useThemeSync } from "@/hooks/relay/useThemes";
import { useDict } from "@/i18n";
import { DEFAULT_THEME, isBuiltinTheme } from "@/lib/theme/builtinThemes";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { deleteTheme } from "@/lib/relay/relayClient";
import type { Theme } from "@/lib/theme/theme";
import { resolveTheme } from "@/lib/theme/themeApply";
import {
  customThemesForHost,
  resolveSelectedTheme,
  setSelectedThemeId,
  setThemesForHost,
  themeStoreKey,
} from "@/lib/theme/themes";
import { cn } from "@/lib/utils";

/**
 * What a theme looks like, in three bars over its own background: the
 * accent, a line of text, a fainter one. Not a miniature of the app's
 * layout — at this size the layout isn't readable anyway, and what
 * actually distinguishes two themes is the contrast between those four
 * colours.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const { colors } = resolveTheme(theme);
  return (
    <span
      className="flex h-14 flex-col justify-center gap-1.5 px-3"
      style={{ background: colors.background }}
    >
      <span className="h-1 w-[64%]" style={{ background: colors.primary }} />
      <span className="h-1 w-full opacity-30" style={{ background: colors.foreground }} />
      <span className="h-1 w-[42%] opacity-15" style={{ background: colors.foreground }} />
    </span>
  );
}

function ThemeCard({
  theme,
  selected,
  kind,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  theme: Theme;
  selected: boolean;
  kind: string;
  onSelect: () => void;
  /** Absent for a built-in (no file anywhere) and for a theme mirrored from
   * a host this device isn't connected to (a file it can't reach). */
  onEdit?: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
}) {
  const dict = useDict();
  const copy = dict.settings.appearance.theme;

  return (
    <div className={cn("group relative flex flex-col border bg-bg-chrome", selected ? "border-primary" : "border-border")}>
      <button
        type="button"
        onClick={onSelect}
        className="flex cursor-pointer flex-col text-left transition-colors hover:bg-surface-hover"
      >
        <ThemePreview theme={theme} />
        <span className="flex items-center gap-2 px-2.5 py-2">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-mono text-[11.5px] text-foreground">{theme.name}</span>
            <span className="truncate font-mono text-[9.5px] tracking-[0.06em] text-text-faint">{kind}</span>
          </span>
          <span
            className={cn(
              "flex size-3 shrink-0 items-center justify-center border",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
            )}
          >
            {selected && <Check className="size-2.5" />}
          </span>
        </span>
      </button>

      {/* The design has no per-theme actions at all; the app does (editing,
          exporting, deleting), so they live behind one control that only
          shows up when the card is pointed at or focused — visible when
          wanted, invisible while choosing. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={copy.options.replace("{name}", theme.name)}
            className="absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center border border-transparent bg-bg-chrome text-text-faint opacity-0 transition-colors group-hover:opacity-100 hover:border-border hover:text-foreground focus-visible:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onEdit && <DropdownMenuItem onSelect={onEdit}>{dict.common.edit}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={onDuplicate}>{dict.common.copy}</DropdownMenuItem>
          {onDelete && <DropdownMenuItem onSelect={onDelete}>{dict.common.delete}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** JSON a person can hand-edit and re-import — every token spelled out,
 * including the ones the app would have derived, so what you get out of
 * "duplicate" is the theme you're actually looking at. */
function themeAsJson(theme: Theme, id: string, name: string): string {
  const resolved = resolveTheme(theme);
  return JSON.stringify(
    { version: 1, id, name, appearance: resolved.appearance, colors: resolved.colors, terminal: resolved.terminal },
    null,
    2,
  );
}

export function ThemeSection({ activeProfile }: { activeProfile: Profile }) {
  const dict = useDict();
  const copy = dict.settings.appearance.theme;
  // One registry, not one per profile: a theme is a file on a machine, and
  // the only machine this device can reliably write to is the one it is
  // connected to right now. Themes mirrored from other hosts stay
  // selectable (the catalog is the union), they just can't be edited or
  // deleted from here — `storeKey` on each entry is what says which is which.
  const registryKey = themeStoreKey(activeProfile);
  const { supported } = useThemeSync(activeProfile);
  const catalog = useThemeCatalog(activeProfile);
  const { theme: current, missing } = resolveSelectedTheme();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState<string | undefined>(undefined);
  const [importIntent, setImportIntent] = useState<ThemeDialogIntent>("import");
  const [pendingDelete, setPendingDelete] = useState<Theme | null>(null);

  function selectTheme(theme: Theme): void {
    // Only the *dark* built-in is stored as "no theme" — it's the fallback a
    // selection resolves to when its file is gone, so storing its id would be
    // storing the absence twice. Every other theme, built-in or not, is
    // stored by id. Collapsing both built-ins here (which is what this used
    // to do) made the light one unselectable: picking it wrote `null`, and
    // `null` resolves to the dark one, so the click appeared to do nothing.
    setSelectedThemeId(theme.id === DEFAULT_THEME.id ? null : theme.id);
  }

  // Editing and duplicating are the same dialog: saving under the same id
  // overwrites the file (the relay treats create and update as one
  // operation), saving under a new one creates a second theme. The only
  // difference is which id/name the JSON arrives with.
  function edit(theme: Theme): void {
    setImportSeed(themeAsJson(theme, theme.id, theme.name));
    setImportIntent("edit");
    setImportOpen(true);
  }

  function duplicate(theme: Theme): void {
    // The id's suffix is fixed ASCII, not dictionary copy: an id is an
    // identifier, and a translated one could carry a character the validator
    // rejects (it allows lowercase, digits and hyphen — "cópia" wouldn't
    // pass). Only the name, which is prose, gets translated.
    const id = `${theme.id === DEFAULT_THEME.id ? "my-theme" : theme.id}-copy`.slice(0, 32);
    setImportSeed(themeAsJson(theme, id, `${theme.name} ${copy.import.copySuffix}`));
    setImportIntent("duplicate");
    setImportOpen(true);
  }

  async function confirmDelete(theme: Theme): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { host, port, token } = await resolveConnection(activeProfile);
      await deleteTheme(host, port, theme.id, token);
      setThemesForHost(registryKey, customThemesForHost(registryKey).filter((entry) => entry.id !== theme.id));
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function kindOf(theme: Theme, local: boolean): string {
    if (isBuiltinTheme(theme.id)) return copy.builtin;
    if (!local) return copy.elsewhere;
    return theme.appearance === "light" ? copy.light : copy.dark;
  }

  return (
    <div className="flex flex-col gap-3 border-b border-border py-5">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13.5px] font-semibold text-foreground">{copy.title}</span>
        <span className="flex-1 text-xs text-muted-foreground">{copy.description}</span>
      </div>

      {missing && <p className="border border-border px-3 py-2 text-xs text-muted-foreground">{copy.missing}</p>}

      {!supported && (
        <p className="border border-border px-3 py-2 text-xs text-muted-foreground">
          {copy.unreadable.replace("{profile}", activeProfile.label)}
        </p>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2.5">
        {catalog.map(({ theme, storeKey }) => {
          const local = storeKey === registryKey;
          return (
            <ThemeCard
              key={theme.id}
              theme={theme}
              kind={kindOf(theme, local)}
              selected={theme.id === current.id && !missing}
              onSelect={() => selectTheme(theme)}
              onEdit={local ? () => edit(theme) : undefined}
              onDuplicate={() => duplicate(theme)}
              onDelete={local ? () => setPendingDelete(theme) : undefined}
            />
          );
        })}

        {supported && (
          <button
            type="button"
            onClick={() => {
              setImportSeed(undefined);
              setImportIntent("import");
              setImportOpen(true);
            }}
            className="flex min-h-[5.75rem] cursor-pointer flex-col items-center justify-center gap-1.5 border border-dashed border-border text-text-faint transition-colors hover:border-text-faint hover:bg-surface-hover hover:text-foreground"
          >
            <Plus className="size-4" />
            <span className="font-mono text-[10.5px]">{copy.add}</span>
          </button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <ThemeImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        profile={activeProfile}
        initialJson={importSeed}
        intent={importIntent}
        onImported={(theme) => selectTheme(theme)}
      />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle.replace("{name}", pendingDelete?.name ?? "")}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            <AlertDialogDescription>{copy.deleteBody}</AlertDialogDescription>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>{dict.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) void confirmDelete(pendingDelete);
              }}
            >
              {busy ? dict.settings.danger.deleting : dict.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
