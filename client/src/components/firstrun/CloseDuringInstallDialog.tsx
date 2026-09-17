import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import { confirmCloseDuringInstall, onCloseRequestedDuringInstall, type CloseAction } from "@/lib/install/localRelay";

/**
 * Rust held the window's close because an install is alive and asks the
 * UI for the decision (`window.confirm` isn't reliable across Tauri's
 * webviews). Three ways out, all answered through
 * `relay_setup_confirm_close`; "stay" just forgets the request.
 */
export function CloseDuringInstallDialog() {
  const copy = useDict().firstRun.local.close;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onCloseRequestedDuringInstall(() => setOpen(true)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function decide(action: CloseAction): void {
    setOpen(false);
    void confirmCloseDuringInstall(action);
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && decide("keep")}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => decide("keep")}>
            {copy.keep}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => decide("cancel")}>
            {copy.cancel}
          </Button>
          <Button type="button" size="sm" onClick={() => decide("background")}>
            {copy.background}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
