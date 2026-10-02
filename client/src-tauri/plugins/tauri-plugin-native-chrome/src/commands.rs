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

#[command]
pub(crate) async fn set_context_target<R: Runtime>(app: AppHandle<R>, payload: ContextTargetRequest) -> Result<()> {
    app.native_chrome().set_context_target(payload)
}

#[command]
pub(crate) async fn set_composer<R: Runtime>(app: AppHandle<R>, payload: ComposerRequest) -> Result<()> {
    app.native_chrome().set_composer(payload)
}

#[command]
pub(crate) async fn set_composer_text<R: Runtime>(app: AppHandle<R>, payload: ComposerTextRequest) -> Result<()> {
    app.native_chrome().set_composer_text(payload)
}

#[command]
pub(crate) async fn focus_composer<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_chrome().focus_composer()
}

#[command]
pub(crate) async fn blur_composer<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_chrome().blur_composer()
}

#[command]
pub(crate) async fn set_composer_elapsed<R: Runtime>(app: AppHandle<R>, payload: ComposerElapsedRequest) -> Result<()> {
    app.native_chrome().set_composer_elapsed(payload)
}

#[command]
pub(crate) async fn set_scroll_to_end<R: Runtime>(app: AppHandle<R>, payload: ScrollToEndRequest) -> Result<()> {
    app.native_chrome().set_scroll_to_end(payload)
}

/// Reads a file the native picker copied into the attachments directory and
/// deletes it. Raw bytes (not JSON) so a long video doesn't get base64'd.
#[command]
pub(crate) async fn read_attachment(payload: ReadAttachmentRequest) -> Result<tauri::ipc::Response> {
    let allowed_root = std::env::temp_dir().join(crate::attachments::ATTACHMENTS_DIR);
    let path = crate::attachments::validate_attachment_path(&allowed_root, std::path::Path::new(&payload.path))?;
    let bytes = std::fs::read(&path)?;
    // Best effort: a leftover file is swept on the next launch.
    let _ = std::fs::remove_file(&path);
    Ok(tauri::ipc::Response::new(bytes))
}
