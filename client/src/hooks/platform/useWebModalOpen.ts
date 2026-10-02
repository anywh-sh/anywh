import { useEffect, useState } from "react";

const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

function isModalOpen(): boolean {
  return document.body.querySelector(MODAL_SELECTOR) !== null;
}

/** True while a modal web dialog is open. The native composer sits above the
 * webview and would cover any of them. */
export function useWebModalOpen(): boolean {
  const [open, setOpen] = useState(isModalOpen);
  useEffect(() => {
    const update = (): void => setOpen(isModalOpen());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "role"] });
    update();
    return () => observer.disconnect();
  }, []);
  return open;
}
