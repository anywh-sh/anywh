use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<NativeChrome<R>> {
  Ok(NativeChrome(app.clone()))
}

/// No native chrome outside iOS — no-op, the real app never depends on
/// this crate on desktop (the app's Cargo.toml only includes it under
/// cfg(target_os = "ios")).
pub struct NativeChrome<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeChrome<R> {
  /// No native menu outside iOS. `selected_id: None` (equivalent to "user
  /// dismissed the menu") instead of an error: the real app never calls this
  /// outside of
  /// `isIOS()`, but returning a harmless result is safer than a
  /// generic error in case that changes in the future.
  pub fn show_context_menu(&self, _payload: ShowContextMenuRequest) -> crate::Result<ShowContextMenuResponse> {
    Ok(ShowContextMenuResponse { selected_id: None })
  }

  pub fn set_top_bar(&self, _payload: TopBarRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_drawer(&self, _payload: DrawerRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_gesture_hint(&self, _payload: GestureHintRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_context_target(&self, _payload: ContextTargetRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_top_bar_menu(&self, _payload: TopBarMenuRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_composer(&self, _payload: ComposerRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_composer_text(&self, _payload: ComposerTextRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn focus_composer(&self) -> crate::Result<()> {
    Ok(())
  }

  pub fn blur_composer(&self) -> crate::Result<()> {
    Ok(())
  }

  pub fn set_composer_elapsed(&self, _payload: ComposerElapsedRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn register_for_push(&self) -> crate::Result<PushRegistration> {
    Err(crate::Error::PushUnsupported)
  }

  pub fn set_visible_session(&self, _payload: VisibleSessionRequest) -> crate::Result<()> {
    Ok(())
  }

  pub fn take_pending_push_tap(&self) -> crate::Result<PendingPushTap> {
    Ok(PendingPushTap::default())
  }

  pub fn set_scroll_to_end(&self, _payload: ScrollToEndRequest) -> crate::Result<()> {
    Ok(())
  }
}
