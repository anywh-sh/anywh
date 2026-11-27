import type { ChatMediaSource } from "@/lib/media/relayMediaSource";

/** A path's bytes as `source` serves them: fetched from the direct URL (the
 * relay answers every route with CORS `*`), or read back from the object URL
 * a tailnet profile's fetch left behind. */
export async function fetchMediaBlob(source: ChatMediaSource, path: string): Promise<Blob> {
  const src = source.url(path) ?? (await source.load(path));
  const response = await fetch(src);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.blob();
}

/**
 * Puts a picture on the clipboard as a PNG, the one image type every
 * webview's clipboard takes, so anything else (a JPEG, a WebP, an SVG) is
 * redrawn into one first. `write` is called at once, inside the click, with
 * the PNG still on its way: WebKit lets a page write the clipboard only
 * during the gesture, and a `ClipboardItem` built on a promise is how the
 * bytes follow after it. A video can't go this way at all: a webview's
 * clipboard takes text, HTML and PNG, never a video file.
 */
export function copyImageToClipboard(image: Promise<Blob>): Promise<void> {
  const png = image.then(asPng);
  // `write` reports a failure of its own; this only keeps one it never gets
  // to read (the clipboard refusing before it asks for the image) from
  // surfacing as an unhandled rejection.
  png.catch(() => {});
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return Promise.reject(new Error("this webview's clipboard takes no images"));
  }
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** `image` as PNG bytes: as it is when it already is one, redrawn on a
 * canvas otherwise (from its own object URL, so nothing taints the canvas). */
export async function asPng(image: Blob): Promise<Blob> {
  if (image.type === "image/png") return image;
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) throw new Error("this image can't be redrawn as a PNG");
    context.drawImage(element, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("the canvas gave no PNG"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
