import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";

export interface UploadResult {
  path: string;
  /** Only present for video — paths of the frames extracted on the relay via
   * ffmpeg (see `relay/src/uploads.ts`), in chronological order. */
  frames?: string[];
}

export async function uploadAttachment(profile: Profile, file: File): Promise<UploadResult> {
  const ext = file.name.includes(".") ? (file.name.split(".").pop() ?? "png") : "png";
  const buffer = await file.arrayBuffer();

  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(`http://${host}:${port}/upload?ext=${encodeURIComponent(ext)}`, {
    method: "POST",
    headers: authHeaders(token),
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`upload falhou: HTTP ${response.status}`);
  }
  return (await response.json()) as UploadResult;
}
