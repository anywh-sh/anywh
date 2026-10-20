import { execFile } from "node:child_process";

export interface ExtractedText {
  text: string;
  pages: number;
}

/**
 * The text of a PDF through `pdftotext` (poppler), extracted once when the
 * file joins a room so no agent pays for the page images. `undefined` when
 * the tool is not installed, fails, or finds no text (a scan): the file is
 * then kept as it is and the index says its text is missing.
 */
export function extractPdfText(path: string, binary = "pdftotext"): Promise<ExtractedText | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error || stdout.trim() === "") {
        resolve(undefined);
        return;
      }
      // One form feed ends each page.
      resolve({ text: stdout, pages: stdout.split("\f").filter((page, i, all) => page.trim() !== "" || i < all.length - 1).length });
    });
  });
}
