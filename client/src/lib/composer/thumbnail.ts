/** A small JPEG data URL of an image (or video frame) preview, `maxSide` px on
 * its longest edge. The native composer can't read `blob:` URLs, so the
 * thumbnail travels as data. Resolves `null` if the image can't be decoded. */
export function thumbnailDataUrl(previewUrl: string, maxSide: number): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return resolve(null);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    image.onerror = () => resolve(null);
    image.src = previewUrl;
  });
}
