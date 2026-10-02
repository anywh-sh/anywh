use serde::{Deserialize, Serialize};

/// Native context menu item — `system_icon` is the name of an
/// SF Symbol (e.g. `"doc.on.doc"`, `"pencil"`), resolved on the Swift side.
/// `disabled_reason` becomes the `UIAction`'s `subtitle` when `disabled` —
/// used by the "edit message with attached image" item (out of scope for
/// v1).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
  pub id: String,
  pub label: String,
  #[serde(default)]
  pub system_icon: Option<String>,
  #[serde(default)]
  pub disabled: bool,
  #[serde(default)]
  pub disabled_reason: Option<String>,
}

/// Coordinates of the touch that triggered the long-press — the
/// WKWebView's own coordinate space (points, not device pixels), the same
/// frame of reference `TouchEvent.clientX/clientY` already uses on the JS
/// side.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuPoint {
  pub x: f64,
  pub y: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowContextMenuRequest {
  pub items: Vec<ContextMenuItem>,
  pub point: ContextMenuPoint,
}

/// `None` when the user dismisses the menu without picking anything (tap
/// outside, or the system itself closes the menu).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowContextMenuResponse {
  pub selected_id: Option<String>,
}

/// Colors of the shell chrome, resolved to `#rrggbb[aa]` by the web side —
/// native code only paints them, it never reads the app's CSS.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellTheme {
  pub background: String,
  pub sidebar: String,
  pub elevated: String,
  pub card: String,
  pub foreground: String,
  pub muted: String,
  pub faint: String,
  pub border: String,
  pub primary: String,
  pub destructive: String,
  pub tint: String,
  pub success: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarRequest {
  pub title: String,
  pub model_label: Option<String>,
  pub connected: bool,
  pub open_sidebar_label: String,
  pub new_conversation_label: String,
  pub connection_label: String,
  pub theme: ShellTheme,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerStrings {
  pub search_sessions: String,
  pub load_failed: String,
  pub retry: String,
  pub empty_title: String,
  pub empty_body: String,
  pub rename: String,
  pub rename_title: String,
  pub rename_description: String,
  pub delete: String,
  pub delete_title: String,
  /// Contains `{title}`, substituted by the native side with the session's title.
  pub delete_body: String,
  pub cancel: String,
  pub save: String,
  pub agent_working: String,
  pub background_job: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerProfile {
  pub id: String,
  pub label: String,
  pub color: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerSession {
  pub id: String,
  pub profile_id: String,
  pub title: String,
  /// Pre-formatted second line (profile label and/or relative time); empty when there is none.
  pub meta: String,
  pub color: String,
  pub running: bool,
  pub background_job: bool,
  pub selected: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerGroup {
  pub id: String,
  pub label: String,
  pub sessions: Vec<DrawerSession>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerRequest {
  pub theme: ShellTheme,
  pub strings: DrawerStrings,
  pub profiles: Vec<DrawerProfile>,
  pub active_profile_id: String,
  pub loading: bool,
  pub error: bool,
  pub groups: Vec<DrawerGroup>,
}

/// Sent on `touchstart`: whether the touch began inside something that
/// scrolls horizontally, so the native edge-anywhere drawer pan must stand down.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GestureHintRequest {
  pub blocked: bool,
}
