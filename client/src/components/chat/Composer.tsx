import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { ArrowUp, Check, ChevronDown, FileText, Mic, Paperclip, Video, X } from "lucide-react";
import { Extension, type JSONContent } from "@tiptap/core";
import { EditorContent, ReactRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import Suggestion from "@tiptap/suggestion";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Button } from "@/components/ui/button";
import { Elapsed } from "@/components/chat/activity/Elapsed";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatDuration } from "@/lib/utils";
import { useDict } from "@/i18n";
import { useDraftSync } from "@/hooks/composer/useDraftSync";
import { useVoiceRecording } from "@/hooks/media/useVoiceRecording";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import { ComposerLinkHoverCard } from "@/components/chat/ComposerLinkHoverCard";
import { PermissionModeButton } from "@/components/chat/PermissionModeButton";
import { ModelButton } from "@/components/chat/ModelButton";
import { EffortButton } from "@/components/chat/EffortButton";
import { AgentPickerButton } from "@/components/chat/AgentPickerButton";
import { ContextUsageButton } from "@/components/chat/ContextUsageButton";
import { CompactBoundaryToast } from "@/components/chat/CompactBoundaryToast";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { HARD_BREAK_ANCHOR, serializeEditorContent } from "@/lib/composer/composerLinks";
import { attachmentName } from "@/lib/composer/attachmentName";
import { decideSubmit } from "@/lib/composer/composerSubmit";
import { effortChoicesFor, type EffortChoices } from "@/lib/composer/effortCatalog";
import { filterSlashCommands, parseSlashCommand, type SlashCommandEntry } from "@/lib/composer/slashCommands";
import type { CompactBoundaryEvent } from "@/hooks/relay/useRelayClient";
import type { Dictionary } from "@/i18n/dictionary";
import type { ContextUsage, ModelCatalog, ModelChoice, PermissionMode, PermissionModeOption } from "@/lib/relay/relayClient";
import type { Profile } from "@/lib/profiles/profiles";

export interface ComposerProps {
  /** Also threaded to `AgentPickerButton`'s own `getHostInfo` fetch. */
  profile: Profile;
  onSend: (text: string, images: PendingAttachment[]) => void;
  disabled?: boolean;
  turnInFlight: boolean;
  /** Epoch ms of the turn's start, for the clock on the stop button. */
  turnStartedAt?: number | null;
  onStop: () => void;
  pendingImages: PendingAttachment[];
  uploadingImage: boolean;
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveImage: (path: string) => void;
  /** `null` only in the brief window before the first `agent_state` arrives
   * — see `useRelayClient`. Drives `AgentPickerButton`'s selection. */
  agentId: string | null;
  onChangeAgent: (agentId: string) => void;
  permissionMode: PermissionMode | null;
  permissionModes: PermissionModeOption[];
  onChangePermissionMode: (mode: PermissionMode) => void;
  /** `null` until the session's first explicit switch (now via
   * `ModelButton` in addition to typing `/model`) — in that case the
   * catalog's own `defaultId` is what runs. */
  model: ModelChoice | null;
  /** The session's agent's model catalog (`useRelayClient`) — drives
   * `ModelButton` and `/model`'s autocomplete. `null` hides the picker: an
   * agent whose def declares no catalog has nothing to pick from. */
  modelCatalog: ModelCatalog | null;
  onChangeModel: (model: ModelChoice) => void;
  /** The explicit reasoning-effort pick (`null` = the model's default) and
   * its setter — drives `EffortButton`, which hides itself for a model with
   * no efforts. */
  effort: string | null;
  onChangeEffort: (effort: string | null) => void;
  /** Same signal as `cwdLocked` (`WorkingDirectoryButton`) — true as soon as
   * the conversation has had its first turn, i.e. "the conversation is
   * locked". Switching the model at that point would require rereading the
   * whole history for the CLI to rebuild context in the new model, so
   * `ModelButton` locks along with the folder; `AgentPickerButton` locks for
   * the same reason. */
  modelLocked: boolean;
  /** Shown in the toolbar's context-usage button. */
  contextUsage: ContextUsage | null;
  /** Sent once, the first time the context usage popover opens — see
   * `ContextUsageButton`. */
  onRequestContextBreakdown: () => void;
  compactBoundary: CompactBoundaryEvent | null;
  /** Next-message suggestion (relay-types.ts) — shown as the composer's
   * placeholder while the field is empty; `Tab` fills it in (see
   * `editorProps.handleKeyDown` below). `null` falls back to the usual
   * generic placeholder. */
  suggestion: string | null;
  /** Prompt-draft feature — called (debounced) whenever the typed text
   * changes, so `useRelayClient` can persist it on the relay. Not called for
   * programmatic content changes (`setContent` below) — see
   * `suppressDraftRef`. */
  onChangeDraft?: (text: string) => void;
}

export interface ComposerHandle {
  focus: () => void;
  /** Replaces the content with plain text (draft restore), or clears it with `""`. Plain text, no markdown/HTML: the same shape `onSend` delivers
   * outward, just in the opposite direction. */
  setContent: (text: string) => void;
}


/**
 * Link rendered as a plain native `<a>` (no `addMarkView`/own `contentDOM`)
 * — the interactive hover card + edit live outside the mark, in
 * `ComposerLinkHoverCard` (a single instance per `Composer`, not per link).
 * A reason, not just a preference: a React Tiptap MarkView here reproducibly
 * breaks ProseMirror's doc-position↔DOM mapping whenever it exists in the
 * document — see the big comment in `ComposerLinkHoverCard.tsx` for the
 * three real bugs this caused (cursor didn't go to the end after pasting a
 * link, pasting over a selection had the same problem, deleting a selected
 * link made the cursor disappear). The rest of the schema (bold, italic,
 * lists, heading etc) stays disabled — the composer is a simple text box,
 * the request is only to support links (via paste or typing), not to become
 * a full rich-text editor. `autolink: true` reuses Tiptap's built-in
 * linkifyjs-based detection (same mark type as paste-to-link, so styling,
 * the hover-card edit, and wire serialization all apply unchanged) — it
 * fires once the typed URL is followed by whitespace.
 *
 * `inclusive: false` overrides the extension's own default, which is
 * `this.options.autolink` — i.e. `true` here. Inclusive means the mark
 * still applies to text typed right at its right edge, so the space that
 * triggers linkify (and everything typed after it) kept inheriting the
 * link mark instead of ending it; the user had to press → to step past the
 * boundary before typing plain text again. False matches how a finished
 * link should behave: typing right after it, including the triggering
 * space, starts as plain text with no extra keypress needed.
 *
 * `shouldAutoLink` narrows both autolink-while-typing and paste-to-link
 * (same callback, called with linkifyjs's raw match — the typed/pasted
 * text before `defaultProtocol` gets prepended for the href) to matches
 * that already spell out a scheme. Without it, linkifyjs's bare-domain
 * detection turns plain text like `test.md` into a link to `http://test.md`
 * on nothing more than `.md` being a registered TLD (Moldova) — surprising
 * for a filename that just happens to share an extension with one.
 */
const REQUIRES_EXPLICIT_PROTOCOL = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const ComposerLink = Link.extend({ inclusive: false }).configure({
  autolink: true,
  linkOnPaste: true,
  openOnClick: false,
  shouldAutoLink: (url) => REQUIRES_EXPLICIT_PROTOCOL.test(url),
  HTMLAttributes: { class: "composer-link", rel: "noopener noreferrer nofollow" },
});

/** Extension wrapper for the cursor-anchoring plugin (see
 * `hardBreakAnchorPlugin` below, defined later due to the file's reading
 * order — the call here only happens when Tiptap mounts the editor, well
 * after module load, so the hoisted function declaration already exists at
 * that point). */
const HardBreakCaretAnchor = Extension.create({
  name: "hardBreakCaretAnchor",
  addProseMirrorPlugins() {
    return [hardBreakAnchorPlugin()];
  },
});

const EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    link: false,
    listItem: false,
    listKeymap: false,
    orderedList: false,
    strike: false,
    underline: false,
  }),
  ComposerLink,
  HardBreakCaretAnchor,
];

/** Rebuilds the Tiptap doc from plain text (draft restore) — via JSON, not an interpolated HTML string: the text may have
 * `<`/`&`/etc that would break a naive HTML parse. A single paragraph with
 * `hardBreak` between lines: the composer's schema never produces more than
 * one paragraph anyway (Enter without shift always sends, never
 * `splitBlock` — see `handleKeyDown` below), so there's no "original
 * paragraph" to restore, just the same sequence of line breaks. */
function buildComposerDoc(text: string): JSONContent {
  const content: JSONContent[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  });
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

/** Dynamic placeholder: shows the next-message suggestion while it exists,
 * otherwise falls back to the generic invitation to type. Needs to be created
 * per `Composer` instance (not a module-level extension, like the rest of
 * `EXTENSIONS`) — each tab has its own suggestion, and `useEditor` doesn't
 * recreate the editor on every prop change, so both values have to come from
 * refs updated on every render (same pattern as `submitRef` below). The
 * fallback is a ref for the same reason the copy can't just be captured: the
 * language can change while the editor stays mounted. */
function createPlaceholderExtension(
  suggestionRef: MutableRefObject<string | null>,
  fallbackRef: MutableRefObject<string>,
) {
  return Placeholder.configure({ placeholder: () => suggestionRef.current ?? fallbackRef.current });
}

/**
 * Real bug, confirmed by testing on Chromium via Playwright (not just
 * theory): a cursor position between two adjacent `<br>`s with no text at
 * all — a genuinely empty line, created by 2+ consecutive `hardBreak`s
 * (Shift+Enter — see `handleKeyDown` below) without
 * typing anything between them — has no layout box of its own:
 * `Range.getClientRects()`/`getBoundingClientRect()` return `(0,0,0,0)` at
 * that position, and the browser falls back to drawing the cursor on the
 * previous line. It's exactly the reported bug: "cursor ends up one line
 * above" after two (or more) breaks.
 *
 * A first attempt via widget decoration (plain DOM, outside the document
 * model — the same technique ProseMirror itself already uses for
 * `<br class="ProseMirror-trailingBreak">`) didn't fix it: ProseMirror marks
 * every widget as `contenteditable=false`, so the browser treats it as a
 * non-editable atom and the selection still anchors on the container element
 * (offset by child index), not inside real text — the rect stayed collapsed.
 * The real fix needs genuinely editable text there, so this inserts a
 * zero-width character (invisible, `HARD_BREAK_ANCHOR`, see
 * `composerLinks.tsx` — `U+FEFF`, not `U+200B`) as real text in the
 * document, not just in the view.
 *
 * `appendTransaction` (not a Shift+Enter-specific command) because it
 * must also cover paste, undo/redo and `setContent` (see `buildComposerDoc`'s
 * comment). Running this as a post-transaction normalization covers both
 * paths (plus paste, undo/redo, `setContent` from composer editing) with a
 * single piece of logic. No infinite loop: inserting the anchor itself makes
 * the "next node isn't real text" condition stop matching on the next
 * pass. */
function hardBreakAnchorPlugin() {
  return new Plugin({
    key: new PluginKey("hardBreakAnchor"),
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const insertPositions: number[] = [];
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== "hardBreak") return;
        const after = pos + node.nodeSize;
        const nextNode = newState.doc.resolve(after).nodeAfter;
        // Needs an anchor when there's nothing after (end of paragraph) or
        // the next node is also a break (genuinely empty line) — real text
        // (even starting with the anchor itself from a previous pass) is
        // already enough as a layout box, doesn't duplicate.
        const needsAnchor = !nextNode || nextNode.type.name === "hardBreak";
        if (needsAnchor) insertPositions.push(after);
      });
      const tr = newState.tr;
      let changed = false;
      if (insertPositions.length > 0) {
        // Back to front: inserting doesn't shift positions not yet
        // processed (they all come before, in the original doc).
        insertPositions
          .sort((a, b) => b - a)
          .forEach((pos) => tr.insertText(HARD_BREAK_ANCHOR, pos));
        changed = true;
      }
      // Re-anchors the cursor when it's right between a `hardBreak` and the
      // anchor that exists right after it (just inserted above, or from a
      // previous pass — ProseMirror's `applyTransaction` restarts the plugin
      // list from scratch whenever some `appendTransaction` returns a new
      // transaction, so this method runs again with the doc already
      // appended, but with NO guarantee that the original dispatch's
      // selection mapping still points after the right text). Content-based
      // check (not position mapping) — works no matter which of these passes
      // triggers it. Without this, the cursor renders one line above where
      // expected on WebKit/iOS even with the anchor present in the document
      // (real bug, confirmed in the Simulator) — on Chromium
      // the browser tolerates the "before" position of the anchor and draws
      // the cursor correctly anyway, masking this same problem.
      const { $head } = tr.selection;
      if (
        tr.selection.empty &&
        $head.nodeBefore?.type.name === "hardBreak" &&
        $head.nodeAfter?.isText &&
        $head.nodeAfter.text?.startsWith(HARD_BREAK_ANCHOR)
      ) {
        tr.setSelection(TextSelection.create(tr.doc, $head.pos + HARD_BREAK_ANCHOR.length));
        tr.scrollIntoView();
        changed = true;
      }
      return changed ? tr : null;
    },
  });
}

/** Colors `/model haiku` etc typed in the composer, only when it's a
 * genuinely recognized command (same check as `parseSlashCommand` — an
 * invalid `/model gpt4` gets no color at all, since it'll become a normal
 * message). Slash with reduced opacity + primary color, command name with
 * full primary color, parameter (if any) with no styling at all — explicit
 * user request. Pure decoration (`Decoration.inline`), doesn't
 * touch the document — the text that goes to `onSend` remains the usual
 * plain text. */
function slashCommandDecorationPlugin(catalogRef: MutableRefObject<ModelCatalog | null>, effortsRef: MutableRefObject<EffortChoices | null>) {
  return new Plugin({
    key: new PluginKey("slashCommandDecoration"),
    props: {
      decorations(state) {
        const text = state.doc.textBetween(0, state.doc.content.size, "\n", "\n");
        if (!parseSlashCommand(text, catalogRef.current, effortsRef.current)) return DecorationSet.empty;
        const match = /^(\/\S+)(\s+\S+)?$/.exec(text);
        if (!match) return DecorationSet.empty;
        // Start of the first (only) paragraph's text — see the composer's
        // schema above, there's never another block node before it.
        const from = 1;
        const commandEnd = from + match[1].length;
        return DecorationSet.create(state.doc, [
          Decoration.inline(from, from + 1, { class: "composer-command-slash" }),
          Decoration.inline(from + 1, commandEnd, { class: "composer-command-name" }),
        ]);
      },
    },
  });
}

/**
 * `/` as the composer's first character (empty until then, Suggestion's
 * `startOfLine` + `allowSpaces` guarantee this) opens an
 * autocomplete popup of available commands. Menu rendered via
 * `ReactRenderer` + `props.mount()` (positioning managed by the package
 * itself via Floating UI, anchored to the cursor) — no React state here:
 * Tiptap's callbacks live outside the render cycle, so the current selection
 * and filtered items sit in variables closed over in
 * `addProseMirrorPlugins`'s closure, updated via `component.updateProps`.
 *
 * `activeRef` is the only channel back to the React component: the
 * editor-level `handleKeyDown` (configured in `useEditor` below) already
 * runs BEFORE ProseMirror's plugins (including Suggestion's) — without this
 * check, Enter would always submit the message instead of letting
 * Suggestion pick the selected item in the menu.
 */
function createSlashCommandExtension(
  activeRef: MutableRefObject<boolean>,
  commandsRef: MutableRefObject<Dictionary["chat"]["composer"]>,
  catalogRef: MutableRefObject<ModelCatalog | null>,
  effortsRef: MutableRefObject<EffortChoices | null>,
) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      let component: ReactRenderer | null = null;
      let unmount: (() => void) | null = null;
      let selectedIndex = 0;
      let currentItems: SlashCommandEntry[] = [];
      let currentCommand: ((entry: SlashCommandEntry) => void) | null = null;

      function applySelection(index: number) {
        selectedIndex = index;
        component?.updateProps({
          items: currentItems,
          selectedIndex,
          onHover: applySelection,
          onPick: currentCommand,
        });
      }

      function close() {
        activeRef.current = false;
        unmount?.();
        component?.destroy();
        component = null;
      }

      return [
        slashCommandDecorationPlugin(catalogRef, effortsRef),
        Suggestion<SlashCommandEntry, SlashCommandEntry>({
          editor: this.editor,
          char: "/",
          startOfLine: true,
          allowSpaces: true,
          // Without this, picking an item reopens the menu right away: the
          // resulting text ("/model fable") still matches "/" at the start
          // of the line, so Suggestion would try to start a new session with
          // just itself as the option. Only shows while the text isn't yet a
          // complete, valid command — same check as `onSend` (ChatPanel) and
          // the visual decoration above.
          shouldShow: ({ text }) => parseSlashCommand(text, catalogRef.current, effortsRef.current) === null,
          items: ({ query }) => filterSlashCommands(query, commandsRef.current, catalogRef.current, effortsRef.current),
          command: ({ editor, range, props }) => {
            editor.chain().focus().insertContentAt(range, props.command).run();
          },
          render: () => ({
            onStart: (props) => {
              currentItems = props.items;
              currentCommand = props.command;
              selectedIndex = 0;
              activeRef.current = currentItems.length > 0;
              component = new ReactRenderer(SlashCommandMenu, {
                editor: props.editor,
                props: { items: currentItems, selectedIndex, onHover: applySelection, onPick: currentCommand },
              });
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => {
              currentItems = props.items;
              currentCommand = props.command;
              selectedIndex = 0;
              activeRef.current = currentItems.length > 0;
              component?.updateProps({ items: currentItems, selectedIndex, onHover: applySelection, onPick: currentCommand });
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                close();
                return true;
              }
              if (currentItems.length === 0) return false;
              if (props.event.key === "ArrowDown") {
                applySelection((selectedIndex + 1) % currentItems.length);
                return true;
              }
              if (props.event.key === "ArrowUp") {
                applySelection((selectedIndex - 1 + currentItems.length) % currentItems.length);
                return true;
              }
              if (props.event.key === "Enter") {
                currentCommand?.(currentItems[selectedIndex]);
                return true;
              }
              return false;
            },
            onExit: close,
          }),
        }),
      ];
    },
  });
}

/** Keyboard focus highlights the whole container (textarea + toolbar), not
 * just the isolated textarea. Voice flow: record → the mic button becomes a
 * stop square with the elapsed time → cancel or stop → transcribe → text
 * lands here for review (it doesn't send on its own). The text field is a
 * Tiptap editor (not a `<textarea>`): needs
 * to support an inline hyperlink (own color, hover with edit) created via
 * paste-to-link — pasting a URL over selected text becomes a link, with no
 * selection the pasted URL already goes in as a link (Tiptap's `Link`
 * native behavior). */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    profile,
    onSend,
    disabled,
    turnInFlight,
    turnStartedAt,
    onStop,
    pendingImages,
    uploadingImage,
    onAddFiles,
    onRemoveImage,
    agentId,
    onChangeAgent,
    permissionMode,
    permissionModes,
    onChangePermissionMode,
    model,
    modelCatalog,
    onChangeModel,
    effort,
    onChangeEffort,
    modelLocked,
    contextUsage,
    onRequestContextBreakdown,
    compactBoundary,
    suggestion,
    onChangeDraft,
  },
  ref,
) {
  const dict = useDict();
  const copy = dict.chat.composer;
  const [focused, setFocused] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<() => void>(() => {});
  const { schedule: scheduleDraftSync, flush: flushDraftSync } = useDraftSync(onChangeDraft);
  // `setContent` (edit-message flow, and the draft restoration in
  // ChatPanel) fires `onUpdate` just like real typing does (Tiptap's
  // `emitUpdate` defaults to `true`) — without this flag, restoring a draft
  // or populating the composer with a message being edited would
  // immediately overwrite the persisted draft with that other text. Doesn't
  // touch `emitUpdate` itself because `isEmpty` below still
  // needs `onUpdate` to fire for those programmatic changes.
  const suppressDraftRef = useRef(false);
  // Suggestion's only channel back (outside React) to the editorProps below
  // — see the comment on `createSlashCommandExtension`.
  const slashMenuActiveRef = useRef(false);
  // The autocomplete's blurbs, reaching Tiptap the same way the suggestion
  // does — the extension is built once, outside React's render cycle, and
  // has no way to read a hook.
  const slashCopyRef = useRef(copy);
  slashCopyRef.current = copy;
  // Same channel for the session's agent's catalog, which `/model` is
  // validated and autocompleted against.
  const modelCatalogRef = useRef(modelCatalog);
  modelCatalogRef.current = modelCatalog;
  // And for what `/effort` accepts: the effective model's levels.
  const effortChoices = effortChoicesFor(modelCatalog, model);
  const effortChoicesRef = useRef(effortChoices);
  effortChoicesRef.current = effortChoices;
  const [slashCommandExtension] = useState(() => createSlashCommandExtension(slashMenuActiveRef, slashCopyRef, modelCatalogRef, effortChoicesRef));
  // Channel back to the dynamic placeholder (see `createPlaceholderExtension`)
  // and to the `Tab` handler below — both live outside Tiptap's render
  // cycle, so they don't see the `suggestion` prop update on their own.
  const suggestionRef = useRef<string | null>(suggestion);
  suggestionRef.current = suggestion;
  // Enter-to-send (below) runs outside React's render cycle, same reason as
  // `suggestionRef` — without this it kept submitting while `disabled` (e.g.
  // relay disconnected), silently dropping the message (`RelayClient.sendMessage`
  // no-ops on a closed socket) since only the send *button* checked `canSend`.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const placeholderRef = useRef(copy.placeholder);
  placeholderRef.current = copy.placeholder;
  const [placeholderExtension] = useState(() => createPlaceholderExtension(suggestionRef, placeholderRef));
  // Set by `submit()` when the text looks like a typo'd command (`/cler`)
  // instead of either a real command or plain text — blocks the send until
  // the user picks the fix or confirms sending as-is (see the banner below
  // `EditorContent`). Cleared on the next edit (`onUpdate`) since any further
  // typing invalidates the suggestion it was computed from.
  const [typoConfirm, setTypoConfirm] = useState<{ text: string; suggestion: string } | null>(null);
  const extensions = useMemo(
    () => [...EXTENSIONS, placeholderExtension, slashCommandExtension],
    [placeholderExtension, slashCommandExtension],
  );

  const editor = useEditor({
    extensions,
    onFocus: () => setFocused(true),
    onBlur: ({ editor: current }) => {
      setFocused(false);
      flushDraftSync(serializeEditorContent(current.getJSON()).trim());
    },
    onUpdate: ({ editor: current }) => {
      setIsEmpty(current.isEmpty);
      setTypoConfirm(null);
      if (suppressDraftRef.current) {
        suppressDraftRef.current = false;
      } else {
        scheduleDraftSync(serializeEditorContent(current.getJSON()).trim());
      }
    },
    editorProps: {
      attributes: { class: "composer-prosemirror", "aria-label": copy.placeholder },
      handleKeyDown: (view, event) => {
        // Command menu open: let Suggestion handle Enter/arrows (see
        // `createSlashCommandExtension`) — without this Enter would always
        // submit instead of filling in the selected command.
        if (event.key === "Enter" && !event.shiftKey && slashMenuActiveRef.current) return false;
        // Backspace right after a Shift+Enter (or between two consecutive
        // breaks, a blank line) didn't undo the line: the cursor sits right
        // after the invisible anchor (`HARD_BREAK_ANCHOR`, see
        // `hardBreakAnchorPlugin` above), so the default Backspace only
        // deletes that zero-width character — and the plugin's own
        // `appendTransaction` detects the `hardBreak` with nothing after it
        // and reinserts the anchor in the same pass, undoing the deletion
        // before any re-render. Visually nothing happens. Here the check
        // intercepts this specific case (the text node right before the
        // cursor is just the anchor, nothing typed) and deletes the anchor
        // and the `hardBreak` together as a single unit, letting
        // `appendTransaction` re-anchor normally on the previous line if
        // needed.
        if (event.key === "Backspace" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const { $head, empty } = view.state.selection;
          const nodeBefore = empty ? $head.nodeBefore : null;
          if (nodeBefore?.isText && nodeBefore.text === HARD_BREAK_ANCHOR) {
            const anchorStart = $head.pos - nodeBefore.nodeSize;
            const hardBreak = view.state.doc.resolve(anchorStart).nodeBefore;
            if (hardBreak?.type.name === "hardBreak") {
              event.preventDefault();
              view.dispatch(view.state.tr.delete(anchorStart - hardBreak.nodeSize, $head.pos).scrollIntoView());
              return true;
            }
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (!disabledRef.current) submitRef.current();
          return true;
        }
        // Empty field with a suggestion shown as a placeholder (see
        // `createPlaceholderExtension`) — `Tab` fills in the text instead of
        // leaving the field (default browser behavior), only in that case;
        // outside it `Tab` behaves normally (doesn't intercept needlessly).
        if (event.key === "Tab" && !event.shiftKey && view.state.doc.textContent.length === 0 && suggestionRef.current) {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(suggestionRef.current));
          return true;
        }
        return false;
      },
      // Ctrl/Cmd+V with an image on the clipboard (e.g. a screenshot tool,
      // or "Copy image" from a browser) — reuses the same upload pipeline
      // as the attach button and drag-and-drop instead of letting
      // ProseMirror try to paste it as inline content.
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(
          (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        onAddFiles(files);
        return true;
      },
    },
  });

  // The editor is created once and never recreated, so neither its ARIA
  // label (set in `editorProps` above) nor the placeholder follow a language
  // switch on their own — the placeholder is a decoration, and ProseMirror
  // only recomputes decorations on a transaction. Dispatching an empty one
  // forces the redraw. Runs only when the language actually changes, which
  // is a rare, deliberate action.
  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute("aria-label", copy.placeholder);
    editor.view.dispatch(editor.state.tr);
  }, [editor, copy.placeholder]);

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    setContent: (text) => {
      if (!editor) return;
      suppressDraftRef.current = true;
      editor.commands.setContent(text ? buildComposerDoc(text) : "");
    },
  }));

  const voice = useVoiceRecording({
    onTranscribed: (text) => {
      if (!editor) return;
      editor
        .chain()
        .focus("end")
        .insertContent(editor.isEmpty ? text : ` ${text}`)
        .run();
    },
    onError: (message) => window.alert(message),
  });

  function performSend(text: string): void {
    onSend(text, pendingImages);
    editor?.commands.clearContent(true);
    // Explicit immediate flush (not the debounce scheduled by the
    // `clearContent`-triggered `onUpdate`) — persists the empty draft right
    // away so it can't reappear if the app crashes in the gap right after
    // sending.
    flushDraftSync("");
    setTypoConfirm(null);
  }

  function submit(): void {
    if (!editor) return;
    const text = serializeEditorContent(editor.getJSON()).trim();
    const decision = decideSubmit({
      text,
      attachmentCount: pendingImages.length,
      confirmedTypoText: typoConfirm?.text ?? null,
      catalog: modelCatalog,
      efforts: effortChoices,
    });
    if (decision.kind === "empty") return;
    if (decision.kind === "typo") {
      setTypoConfirm({ text, suggestion: decision.suggestion });
      return;
    }
    performSend(text);
  }
  submitRef.current = submit;

  function applyTypoSuggestion(): void {
    if (!editor || !typoConfirm) return;
    suppressDraftRef.current = true;
    editor.commands.setContent(buildComposerDoc(typoConfirm.suggestion));
    editor.commands.focus("end");
    setTypoConfirm(null);
  }

  // The command itself is typed in the middle of the sentence, in mono — so
  // the copy is split around its placeholder instead of interpolated.
  const typoQuestion = copy.typo.question.split("{command}");
  const isRecording = voice.state === "recording";
  const isTranscribing = voice.state === "transcribing";
  const canSend = !disabled && (!isEmpty || pendingImages.length > 0);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        // Square, like every other box in the app: the border is the whole
        // frame, and it firms up under the pointer the way the outline
        // buttons inside it do.
        "flex flex-col gap-1.5 border p-2 transition-colors",
        "mb-3 bg-bg-sidebar",
        focused ? "border-primary" : "border-border hover:border-text-faint",
      )}
    >
      <ComposerLinkHoverCard editor={editor} />

      {pendingImages.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          {pendingImages.map((image) =>
            image.previewUrl ? (
              <div key={image.path} className="group relative">
                <img src={image.previewUrl} alt="" className="size-14 object-cover" />
                {image.kind === "video" && (
                  <div className="pointer-events-none absolute bottom-0 left-0 flex size-4 items-center justify-center bg-media-scrim text-media-scrim-foreground">
                    <Video className="size-2.5" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveImage(image.path)}
                  aria-label={copy.removeAttachment}
                  className="absolute -top-1.5 -right-1.5 flex size-4 cursor-pointer items-center justify-center border border-border bg-bg-elevated text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                >
                  <X className="size-2.5" />
                </button>
              </div>
            ) : (
              // Nothing to preview (a video in a codec the webview can't
              // decode): the design's mono chip, which names the file
              // instead of standing in for a picture nobody can see.
              <span
                key={image.path}
                className="flex h-7 items-center gap-2 border border-border bg-bg-sidebar px-2 font-mono text-[10.5px] text-muted-foreground"
              >
                {image.kind === "video" ? <Video className="size-3 text-primary" /> : <FileText className="size-3 text-primary" />}
                <span className="max-w-40 truncate">{attachmentName(image.path, copy.unnamedAttachment)}</span>
                <button
                  type="button"
                  onClick={() => onRemoveImage(image.path)}
                  aria-label={copy.removeAttachment}
                  className="cursor-pointer text-text-faint transition-colors hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </span>
            ),
          )}
        </div>
      )}

      {typoConfirm && (
        <div className="flex items-center justify-between gap-2 border border-border bg-bg-sidebar px-2.5 py-1.5">
          <span className="min-w-0 truncate font-sans text-xs text-muted-foreground">
            {typoQuestion[0]}
            <span className="font-mono text-foreground">{typoConfirm.suggestion}</span>
            {typoQuestion[1]}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="xs" className="text-primary" onClick={applyTypoSuggestion}>
              {copy.typo.use}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => performSend(typoConfirm.text)}>
              {copy.typo.sendAnyway}
            </Button>
          </div>
        </div>
      )}

      <EditorContent editor={editor} className="composer-editor" />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-[18px] px-1">
          <AgentPickerButton profile={profile} agentId={agentId} onChange={onChangeAgent} locked={modelLocked} />
          <PermissionModeButton mode={permissionMode} available={permissionModes} onChange={onChangePermissionMode} />
          {modelCatalog && (
            <ModelButton
              model={model}
              catalog={modelCatalog}
              onChange={onChangeModel}
              disabled={disabled ?? false}
              locked={modelLocked}
            />
          )}
          <EffortButton effort={effort} model={model} catalog={modelCatalog} onChange={onChangeEffort} disabled={disabled ?? false} />
          <ContextUsageButton usage={contextUsage} onOpen={onRequestContextBreakdown} />
          <CompactBoundaryToast event={compactBoundary} />
          {isTranscribing && <span className="font-mono text-[11px] text-muted-foreground">{copy.transcribing}</span>}
          {uploadingImage && !isRecording && !isTranscribing && (
            <span className="font-mono text-[11px] text-muted-foreground">{copy.attachmentUploading}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {!isRecording && !isTranscribing && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) onAddFiles(event.target.files);
                  event.target.value = "";
                  editor?.commands.focus();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                aria-label={copy.attach}
              >
                <Paperclip className="size-3.5" />
              </Button>
            </>
          )}

          {isRecording && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={voice.cancel} aria-label={copy.cancelRecording}>
              <X className="size-3.5" />
            </Button>
          )}

          <div className="flex items-center">
            {/* Recording turns the button itself into the state: a stop
                square and the elapsed time, in place of the microphone.
                The waveform that used to sit in the toolbar is gone —
                it animated nothing real (a generic loop, never the
                captured audio), and the timer next to a red button
                already says "this is live". */}
            <Button
              type="button"
              variant={isRecording ? "destructive" : "ghost"}
              size={isRecording ? "sm" : "icon-sm"}
              onClick={() => (isRecording ? void voice.stop() : void voice.start())}
              disabled={isTranscribing || (!isRecording && voice.devices.length === 0)}
              aria-label={isRecording ? copy.stopRecording : copy.record}
            >
              {isRecording ? (
                <>
                  <span className="size-2 bg-current" />
                  {formatDuration(voice.elapsedSeconds)}
                </>
              ) : (
                <Mic className="size-3.5" />
              )}
            </Button>

            {voice.devices.length > 1 && !isRecording && !isTranscribing && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={copy.selectMicrophone}
                    className="flex h-7 w-3.5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{copy.microphone}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {voice.devices.map((name) => (
                    <DropdownMenuItem key={name} onSelect={() => voice.setSelectedDevice(name)}>
                      <Check className={cn("size-3.5", name !== voice.selectedDevice && "opacity-0")} />
                      <span className="max-w-48 truncate">{name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {turnInFlight ? (
            // Neutral, not red: stopping is an ordinary action here, and
            // the clock beside it is the turn's only running counter.
            <Button type="button" size="sm" variant="outline" className="text-muted-foreground" aria-label={dict.common.stop} onClick={onStop}>
              <span className="size-2 bg-current" />
              {turnStartedAt != null && <Elapsed startedAt={turnStartedAt} className="font-mono text-[11px]" />}
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!canSend} aria-label={dict.common.send} className="size-[26px]">
              <ArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
});
