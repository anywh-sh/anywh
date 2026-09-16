import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";

// Where images/videos attached by the client get saved — needs to be a path
// that the relay's `claude -p` process can read (same machine), so it can
// use the Read tool and genuinely "see" the image.
const UPLOAD_DIR = process.env.RELAY_UPLOAD_DIR ?? "/tmp/anywh-uploads";
mkdirSync(UPLOAD_DIR, { recursive: true });

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB — a short flow/animation video easily exceeds an image's 25MB.

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);
const VIDEO_FRAME_COUNT = 6;

export interface UploadResult {
  path: string;
  /** Only present for video — paths of the frames extracted via ffmpeg, in
   * chronological order (Claude only "sees" images via `Read`, not
   * video, so this is what actually becomes visual context). */
  frames?: string[];
}

/** Shared by this module's `/upload` (chat attachments) and the file panel's
 * `/files/upload` (server.ts) — both need the same raw-body-with-size-cap
 * accumulator, just against different limits/destinations. */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`upload maior que o limite de ${String(Math.floor(maxBytes / (1024 * 1024)))}MB`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

export function saveUpload(req: IncomingMessage, ext: string): Promise<UploadResult> {
  return readRawBody(req, MAX_UPLOAD_BYTES).then((buffer) => handleUploadComplete(buffer, ext));
}

async function handleUploadComplete(buffer: Buffer, ext: string): Promise<UploadResult> {
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  const id = randomUUID();
  const filePath = join(UPLOAD_DIR, `${id}.${safeExt}`);
  writeFileSync(filePath, buffer);

  if (!VIDEO_EXTENSIONS.has(safeExt.toLowerCase())) {
    return { path: filePath };
  }

  try {
    const frames = await extractVideoFrames(filePath, id);
    return { path: filePath, frames };
  } catch (error) {
    // Doesn't fail the upload because of this — the original video is
    // already saved and can still be referenced (Claude can run ffmpeg on
    // it via Bash), it just doesn't get the frames as direct image context.
    console.error("[relay] failed to extract video frames:", error);
    return { path: filePath };
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} saiu com código ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const out = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const duration = parseFloat(out.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 1;
}

// Frames taken at the midpoint of N equal slices of the duration (not at
// t=0/t=end) — avoids landing on a black fade-in/fade-out at the edges,
// common in screen recordings.
async function extractVideoFrames(videoPath: string, baseId: string): Promise<string[]> {
  const duration = await getVideoDuration(videoPath);
  const frames: string[] = [];
  for (let i = 0; i < VIDEO_FRAME_COUNT; i++) {
    const timestamp = (duration * (i + 0.5)) / VIDEO_FRAME_COUNT;
    const framePath = join(UPLOAD_DIR, `${baseId}-frame${String(i + 1)}.jpg`);
    await runCommand("ffmpeg", ["-y", "-ss", timestamp.toFixed(2), "-i", videoPath, "-frames:v", "1", "-q:v", "3", framePath]);
    frames.push(framePath);
  }
  return frames;
}
