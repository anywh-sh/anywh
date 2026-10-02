use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_chrome);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<NativeChrome<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("", "NativeChromePlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_native_chrome)?;
  Ok(NativeChrome(handle))
}

/// Access to the native-chrome APIs.
pub struct NativeChrome<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NativeChrome<R> {
  pub fn show_context_menu(&self, payload: ShowContextMenuRequest) -> crate::Result<ShowContextMenuResponse> {
    self
      .0
      .run_mobile_plugin("showContextMenu", payload)
      .map_err(Into::into)
  }

  pub fn set_top_bar(&self, payload: TopBarRequest) -> crate::Result<()> {
    self.0.run_mobile_plugin("setTopBar", payload).map_err(Into::into)
  }

  pub fn set_drawer(&self, payload: DrawerRequest) -> crate::Result<()> {
    self.0.run_mobile_plugin("setDrawer", payload).map_err(Into::into)
  }

  pub fn set_gesture_hint(&self, payload: GestureHintRequest) -> crate::Result<()> {
    self.0.run_mobile_plugin("setGestureHint", payload).map_err(Into::into)
  }
}
