use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::NativeChromeExt;
use crate::Result;

/// Native context menu — blocks (from this async command's point
/// of view) until the user picks an item or dismisses the menu; same
/// pattern as other Tauri plugins that wait on user interaction (e.g. the
/// `tauri-plugin-macos-permissions` permission dialog), doesn't impose any
/// timeout of its own.
#[command]
pub(crate) async fn show_context_menu<R: Runtime>(
    app: AppHandle<R>,
    payload: ShowContextMenuRequest,
) -> Result<ShowContextMenuResponse> {
    app.native_chrome().show_context_menu(payload)
}
