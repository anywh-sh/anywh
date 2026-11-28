import { Children, isValidElement, type ReactNode } from "react";
import { MediaLayoutContext } from "@/components/chat/media/chatMediaContext";

/**
 * A run of images or videos in a message (`remarkMediaGallery` groups
 * them): one alone is drawn large, several as a wrapping row of smaller
 * tiles at one height, each at its own proportion — a portrait phone
 * capture and a wide chart side by side without cropping either.
 */
export function MediaGallery({ children }: { children: ReactNode }) {
  const count = Children.toArray(children).filter(isValidElement).length;
  return (
    <MediaLayoutContext.Provider value={count > 1 ? "grid" : "single"}>
      <div data-media-gallery="" className="flex flex-wrap items-start gap-1.5">
        {children}
      </div>
    </MediaLayoutContext.Provider>
  );
}
