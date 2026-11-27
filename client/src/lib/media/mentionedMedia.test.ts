import { describe, expect, it } from "vitest";
import { MAX_MENTIONED_MEDIA, mentionedMedia } from "@/lib/media/mentionedMedia";

describe("mentionedMedia", () => {
  it("finds the media files a reply names as inline code, bare or absolute, in order", () => {
    const reply = "Criei os ícones na pasta atual:\n\n- `foguete-azul.svg`\n- `foguete-verde.svg`\n\nE a captura está em `/tmp/sim/home.png`.";
    expect(mentionedMedia(reply)).toEqual([
      { path: "foguete-azul.svg", kind: "image" },
      { path: "foguete-verde.svg", kind: "image" },
      { path: "/tmp/sim/home.png", kind: "image" },
    ]);
  });

  it("names a recording as a video", () => {
    expect(mentionedMedia("Gravei em `/tmp/sim/flow.mov`.")).toEqual([{ path: "/tmp/sim/flow.mov", kind: "video" }]);
  });

  it("leaves out what isn't media, isn't a path, or sits in a fenced block", () => {
    const reply = "Mexi em `src/App.tsx` e rodei `npm test`.\n\n```\nscreenshots/old.png\n`inside.png`\n```\n";
    expect(mentionedMedia(reply)).toEqual([]);
  });

  it("skips a file the reply already embeds, whether named by its full path or by its name", () => {
    const reply = "![Azul](/tmp/out/foguete-azul.svg) `foguete-azul.svg`\n\nO verde ficou em `/tmp/out/foguete-verde.svg`, e de novo `/tmp/out/foguete-verde.svg`.";
    expect(mentionedMedia(reply)).toEqual([{ path: "/tmp/out/foguete-verde.svg", kind: "image" }]);
  });

  it("stops at the cap", () => {
    const reply = Array.from({ length: MAX_MENTIONED_MEDIA + 3 }, (_, index) => `\`shot-${String(index)}.png\``).join(" ");
    expect(mentionedMedia(reply)).toHaveLength(MAX_MENTIONED_MEDIA);
  });
});
