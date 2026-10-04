use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod attachments;
mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::NativeChrome;
#[cfg(mobile)]
use mobile::NativeChrome;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the native-chrome APIs.
pub trait NativeChromeExt<R: Runtime> {
  fn native_chrome(&self) -> &NativeChrome<R>;
}

impl<R: Runtime, T: Manager<R>> crate::NativeChromeExt<R> for T {
  fn native_chrome(&self) -> &NativeChrome<R> {
    self.state::<NativeChrome<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("native-chrome")
    .invoke_handler(tauri::generate_handler![
      commands::show_context_menu,
      commands::set_top_bar,
      commands::set_top_bar_menu,
      commands::set_drawer,
      commands::set_gesture_hint,
      commands::set_context_target,
      commands::set_composer,
      commands::set_composer_text,
      commands::focus_composer,
      commands::blur_composer,
      commands::set_composer_elapsed,
      commands::set_scroll_to_end,
      commands::read_attachment
    ])
    .setup(|app, api| {
      #[cfg(mobile)]
      let native_chrome = mobile::init(app, api)?;
      #[cfg(desktop)]
      let native_chrome = desktop::init(app, api)?;
      app.manage(native_chrome);
      Ok(())
    })
    .build()
}
