import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listInputDevicesMock, ensureMicrophonePermissionMock, startRecordingMock } = vi.hoisted(() => ({
  listInputDevicesMock: vi.fn((): Promise<string[]> => Promise.resolve([])),
  ensureMicrophonePermissionMock: vi.fn(() => Promise.resolve()),
  startRecordingMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/platform/voice", () => ({
  listInputDevices: listInputDevicesMock,
  ensureMicrophonePermission: ensureMicrophonePermissionMock,
  startRecording: startRecordingMock,
  stopRecordingAndTranscribe: vi.fn(() => Promise.resolve("")),
  MicrophonePermissionError: class MicrophonePermissionError extends Error {},
}));

import { useVoiceRecording } from "@/hooks/media/useVoiceRecording";

beforeEach(() => {
  localStorage.clear();
  listInputDevicesMock.mockReset().mockResolvedValue([]);
  ensureMicrophonePermissionMock.mockReset().mockResolvedValue(undefined);
  startRecordingMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

// Mounts the hook and waits for its device-list effect (listInputDevices())
// to settle before handing back the render result, so `devices` reflects the
// mock's resolved value by the time a test calls `start()`.
async function setup(onError: (message: string) => void) {
  const { result } = renderHook(() => useVoiceRecording({ onTranscribed: vi.fn(), onError }));
  await act(async () => {
    await listInputDevicesMock.mock.results[0]?.value;
  });
  return result;
}

describe("useVoiceRecording — start", () => {
  it("blocks recording and reports an error when no microphone is available", async () => {
    const onError = vi.fn();
    const result = await setup(onError);

    await act(async () => {
      await result.current.start();
    });

    expect(onError).toHaveBeenCalledWith("No microphone available. Connect one and try again.");
    expect(startRecordingMock).not.toHaveBeenCalled();
    expect(ensureMicrophonePermissionMock).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it("starts recording when at least one microphone is available", async () => {
    listInputDevicesMock.mockResolvedValue(["Built-in Microphone"]);
    const onError = vi.fn();
    const result = await setup(onError);

    await act(async () => {
      await result.current.start();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(startRecordingMock).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("recording");
  });
});
