import { invoke } from "@tauri-apps/api/core";
import { isMacOS } from "@/lib/platform/platform";

export async function listInputDevices(): Promise<string[]> {
  return await invoke<string[]>("list_input_devices");
}

/** Raised when macOS never granted the permission the call below asks for.
 * A type rather than a sentence because the sentence belongs to the
 * dictionary, and this module has no locale — same split the relay's error
 * codes already follow: the failure travels as a thing, the wording is
 * chosen where the user is. */
export class MicrophonePermissionError extends Error {
  constructor() {
    super("microphone permission not granted");
    this.name = "MicrophonePermissionError";
  }
}

/** cpal accesses CoreAudio directly on macOS, which doesn't trigger the
 * native permission dialog — without this the app records only silence
 * (whisper "hallucinates" text like "[Music]"). Forces the real permission
 * request via AVFoundation before recording. No-op on other platforms. */
export async function ensureMicrophonePermission(): Promise<void> {
  if (!isMacOS()) return;

  const { checkMicrophonePermission, requestMicrophonePermission } = await import(
    "tauri-plugin-macos-permissions-api"
  );

  if (await checkMicrophonePermission()) return;

  await requestMicrophonePermission();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await checkMicrophonePermission()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new MicrophonePermissionError();
}

export async function startRecording(deviceName: string | undefined): Promise<void> {
  await invoke("start_recording", { deviceName });
}

export async function stopRecordingAndTranscribe(): Promise<string> {
  return await invoke<string>("stop_recording_and_transcribe");
}
