import { Check, ChevronDown, Mic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatDuration } from "@/lib/utils";
import { useDict } from "@/i18n";
import type { UseVoiceRecordingResult } from "@/hooks/media/useVoiceRecording";

/**
 * The composer's microphone: a cancel button while recording, the record/stop
 * button itself and, with more than one input, the device picker. The
 * recording is the caller's `useVoiceRecording`, which decides where the
 * transcript lands.
 */
export function VoiceButton({ voice }: { voice: UseVoiceRecordingResult }) {
  const copy = useDict().chat.composer;
  const isRecording = voice.state === "recording";
  const isTranscribing = voice.state === "transcribing";
  return (
    <>
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
          className={isRecording ? undefined : "size-[30px] text-text-faint"}
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
            <Mic className="size-4" />
          )}
        </Button>

        {voice.devices.length > 1 && !isRecording && !isTranscribing && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={copy.selectMicrophone}
                className="flex h-[30px] w-5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground data-[state=open]:bg-surface-hover data-[state=open]:text-foreground"
              >
                <ChevronDown className="size-3 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[calc(240px*var(--chrome-scale))]">
              <DropdownMenuLabel>{copy.microphone}</DropdownMenuLabel>
              {voice.devices.map((name) => (
                <DropdownMenuItem key={name} onSelect={() => voice.setSelectedDevice(name)} className={cn(name === voice.selectedDevice && "text-foreground")}>
                  <span className="min-w-0 flex-1 truncate text-left">{name}</span>
                  <Check className={cn("size-3.5 shrink-0 text-foreground", name !== voice.selectedDevice && "opacity-0")} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  );
}
