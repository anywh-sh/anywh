import type { KeyboardEvent } from "react";

/**
 * Arrow keys for a group of tabs or radios, the way a native one behaves:
 * Left/Up and Right/Down move to the previous/next option (wrapping), Home
 * and End to the ends, and the option moved to is selected — selection
 * follows focus. Only the selected option is in the Tab order (the caller
 * gives it `tabIndex={0}` and the rest `-1`), so Tab enters and leaves the
 * group in one step. Attach to the group's container.
 */
export function handleRovingKeyDown(event: KeyboardEvent<HTMLElement>, role: "tab" | "radio"): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]`)).filter((item) => !item.hasAttribute("disabled"));
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index === -1 || items.length === 0) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (index + 1) % items.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = (index - 1 + items.length) % items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  items[next].focus();
  items[next].click();
}
