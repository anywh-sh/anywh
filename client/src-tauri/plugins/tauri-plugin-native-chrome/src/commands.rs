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

#[command]
pub(crate) async fn set_top_bar<R: Runtime>(app: AppHandle<R>, payload: TopBarRequest) -> Result<()> {
    app.native_chrome().set_top_bar(payload)
}

#[command]
pub(crate) async fn set_drawer<R: Runtime>(app: AppHandle<R>, payload: DrawerRequest) -> Result<()> {
    app.native_chrome().set_drawer(payload)
}

#[command]
pub(crate) async fn set_gesture_hint<R: Runtime>(app: AppHandle<R>, payload: GestureHintRequest) -> Result<()> {
    app.native_chrome().set_gesture_hint(payload)
}
