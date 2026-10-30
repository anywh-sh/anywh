import { describe, expect, it } from "vitest";
import { attachmentKindFor, fileExtension, uploadExtension } from "@/lib/composer/attachmentTypes";

const file = (name: string, type = "") => ({ name, type });

describe("attachmentKindFor", () => {
  it("classifies by extension even when the MIME type is empty or generic", () => {
    expect(attachmentKindFor(file("notes.md"))).toBe("file");
    expect(attachmentKindFor(file("spec.PDF", "application/octet-stream"))).toBe("file");
    expect(attachmentKindFor(file("main.rs"))).toBe("file");
    expect(attachmentKindFor(file("shot.png", "application/octet-stream"))).toBe("image");
    expect(attachmentKindFor(file("clip.mov"))).toBe("video");
  });

  it("accepts the conventional extensionless text files, case-insensitively", () => {
    expect(attachmentKindFor(file("Makefile"))).toBe("file");
    expect(attachmentKindFor(file("Dockerfile"))).toBe("file");
  });

  it("falls back to the MIME type only for media, for a pasted image with no usable name", () => {
    expect(attachmentKindFor(file("image", "image/png"))).toBe("image");
    expect(attachmentKindFor(file("blob", "text/plain"))).toBeNull();
  });

  it("refuses anything off the list", () => {
    expect(attachmentKindFor(file("setup.exe", "application/x-msdownload"))).toBeNull();
    expect(attachmentKindFor(file("archive.zip", "application/zip"))).toBeNull();
    expect(attachmentKindFor(file(".env"))).toBeNull();
  });
});

describe("fileExtension", () => {
  it("ignores a leading or trailing dot", () => {
    expect(fileExtension(".gitignore")).toBeNull();
    expect(fileExtension("weird.")).toBeNull();
    expect(fileExtension("a.tar.GZ")).toBe("gz");
  });
});

describe("uploadExtension", () => {
  it("never turns an extensionless text file into .png", () => {
    expect(uploadExtension(file("Makefile"))).toBe("txt");
  });

  it("derives a nameless image's extension from its media type", () => {
    expect(uploadExtension(file("image", "image/jpeg"))).toBe("jpg");
    expect(uploadExtension(file("image", "image/png"))).toBe("png");
  });

  it("keeps the file's own extension", () => {
    expect(uploadExtension(file("notes.md"))).toBe("md");
  });
});
