import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureMicrophonePermission,
  listInputDevices,
  MicrophonePermissionError,
  startRecording,
  stopRecordingAndTranscribe,
} from "@/lib/platform/voice";
import { useDict } from "@/i18n";
import { isIOS } from "@/lib/platform/platform";

const MIC_STORAGE_KEY = "anywh:selected-mic";

export type VoiceRecordingState = "idle" | "recording" | "transcribing";

export interface UseVoiceRecordingOptions {
  onTranscribed: (text: string) => void;
  onError: (message: string) => void;
}

export interface UseVoiceRecordingResult {
  state: VoiceRecordingState;
  elapsedSeconds: number;
  devices: string[];
  selectedDevice: string;
  setSelectedDevice: (name: string) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

/** State envelope on top of the 3 existing Tauri commands (voice.rs, no
 * change) — records (the composer's mic button becomes a stop square with a
 * timer) → transcribes → text lands in the
 * composer for review, without sending on its own. */
export function useVoiceRecording({ onTranscribed, onError }: UseVoiceRecordingOptions): UseVoiceRecordingResult {
  const copy = useDict().chat.composer.voiceErrors;
  const [state, setState] = useState<VoiceRecordingState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDeviceState] = useState("");

  const cancelledRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Voice is out of scope for the iOS MVP — the command doesn't exist in the
    // iOS build (commit b6b8e63), invoking it here would just reject the promise for nothing.
    if (isIOS()) return;
    listInputDevices()
      .then((names) => {
        setDevices(names);
        const saved = localStorage.getItem(MIC_STORAGE_KEY);
        if (saved && names.includes(saved)) setSelectedDeviceState(saved);
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to list microphones", error);
      });
  }, []);

  const setSelectedDevice = useCallback((name: string) => {
    setSelectedDeviceState(name);
    localStorage.setItem(MIC_STORAGE_KEY, name);
  }, []);

  function stopTimer(): void {
    if (timerRef.current !== undefined) {
      window.clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }

  const start = useCallback(async () => {
    if (isIOS()) return;
    if (devices.length === 0) {
      onError(copy.noMicrophone);
      return;
    }
    cancelledRef.current = false;
    try {
      await ensureMicrophonePermission();
      await startRecording(selectedDevice || undefined);
    } catch (error) {
      onError(
        error instanceof MicrophonePermissionError
          ? copy.microphonePermission
          : copy.startFailed.replace("{reason}", error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    setState("recording");
    setElapsedSeconds(0);
    timerRef.current = window.setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
  }, [devices, selectedDevice, onError, copy]);

  const stop = useCallback(async () => {
    stopTimer();
    setState("transcribing");
    try {
      const text = await stopRecordingAndTranscribe();
      if (!cancelledRef.current) onTranscribed(text);
    } catch (error) {
      if (!cancelledRef.current) {
        onError(copy.transcriptionFailed.replace("{reason}", error instanceof Error ? error.message : String(error)));
      }
    } finally {
      setState("idle");
    }
  }, [onTranscribed, onError, copy]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stopTimer();
    setState("idle");
    // There's no separate "discard" command on the Rust side — fires the
    // real stop in the background just to end the capture, ignoring
    // the result. Cancel stays instant from the UI's point of view.
    void stopRecordingAndTranscribe().catch(() => {});
  }, []);

  return { state, elapsedSeconds, devices, selectedDevice, setSelectedDevice, start, stop, cancel };
}
