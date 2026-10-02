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
