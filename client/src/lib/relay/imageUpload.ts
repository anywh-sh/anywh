import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";
import { uploadExtension } from "@/lib/composer/attachmentTypes";

export interface UploadResult {
  path: string;
  /** Only present for video — paths of the frames extracted on the relay via
   * ffmpeg (see `relay/src/uploads.ts`), in chronological order. */
  frames?: string[];
}

export async function uploadAttachment(profile: Profile, file: File): Promise<UploadResult> {
  const buffer = await file.arrayBuffer();

  const { host, port, token } = await resolveConnection(profile);
  // `name` is informational: the relay still saves under a fresh id, and one
  // that predates the parameter just ignores it.
  const query = new URLSearchParams({ ext: uploadExtension(file), name: file.name });
  const response = await fetch(`http://${host}:${port}/upload?${query.toString()}`, {
    method: "POST",
    headers: authHeaders(token),
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`upload falhou: HTTP ${response.status}`);
  }
  return (await response.json()) as UploadResult;
}
