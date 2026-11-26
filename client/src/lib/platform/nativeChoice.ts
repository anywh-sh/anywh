import { invoke } from "@tauri-apps/api/core";
import { listenPluginEvents } from "@/lib/platform/pluginEvents";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";

/** One option of the question on screen, already worded and translated. */
export interface NativeChoiceOption {
  label: string;
  description: string | null;
  selected: boolean;
}

/**
 * One step (question) of a pending prompt, as iOS draws it: a row inside the
 * native composer, and the native sheet that row opens. The web side owns the
 * answer being built and resends this after every change; the native side
 * only draws it and reports taps and typing back (`NativeChoiceHandlers`).
 */
export interface NativeChoicePayload {
  /** Identifies the question on screen; a new one resets the free-text field
   * and the scroll position. */
  stepKey: string;
  /** The composer row. */
  banner: { label: string; text: string; openLabel: string };
  /** Small label above the question: its header, or the kind of prompt. */
  kicker: string;
  /** "1 of 3", only when the prompt has more than one question. */
  position: string | null;
  question: string;
  multiSelect: boolean;
  options: NativeChoiceOption[];
  /** Free text was typed: it is the answer, and the options step back. */
  optionsDimmed: boolean;
  /** The free-text answer field, when the question takes one. `text` is only
   * applied when `stepKey` changes: a payload never overwrites what is being
   * typed. */
  custom: { text: string; placeholder: string; label: string; secret: boolean } | null;
  canGoBack: boolean;
  /** `false` while the relay can't be reached. */
  canAnswer: boolean;
  /** Why answering is held back, or `null`. */
  status: string | null;
  submitLabel: string;
  skipLabel: string;
  strings: { close: string; previous: string };
  theme: NativeShellTheme;
}

/** What the native question sheet reports. It decides nothing: each of these
 * is a tap or an edit, and the handlers decide what it does to the answer. */
export interface NativeChoiceHandlers {
  choiceToggleOption: (event: { index: number }) => void;
  choiceCustomTextChange: (event: { text: string }) => void;
  choicePrevious: () => void;
  choiceSubmit: () => void;
  choiceSkip: () => void;
}

/** `null` takes the composer row away and closes the sheet if it is open. */
export function setNativeChoice(choice: NativeChoicePayload | null): Promise<void> {
  return invoke("plugin:native-chrome|set_choice", { payload: { choice } });
}

/** Subscribes to every event of the native question sheet. Resolves to one
 * function that removes them all. */
export function listenNativeChoice(handlers: NativeChoiceHandlers): Promise<() => void> {
  return listenPluginEvents("native-chrome", handlers);
}
