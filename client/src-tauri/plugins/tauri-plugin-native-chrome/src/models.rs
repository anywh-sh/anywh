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
  pub primary_foreground: String,
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
pub struct TopBarMenuOption {
  pub id: String,
  pub label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarModelMenu {
  pub label: String,
  pub current_id: Option<String>,
  pub current_label: String,
  pub options: Vec<TopBarMenuOption>,
  pub locked: bool,
  pub locked_hint: String,
  pub enabled: bool,
}

/// Contents of the dropdown the top bar's center opens. `model: None` means
/// there is nothing to offer, so the bar stays a plain label.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarMenuRequest {
  pub model: Option<TopBarModelMenu>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerStrings {
  /// Label of the button after the list, shown when `has_more`.
  pub all_chats: String,
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
  /// Pre-formatted second line (the relative time); empty when there is none.
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
  pub has_more: bool,
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

/// One pending attachment shown in the composer. The native side only draws
/// it; `path` is the id handed back on removal.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerAttachment {
  pub path: String,
  /// `"image"` or `"video"`.
  pub kind: String,
  /// `data:image/jpeg;base64,…`, or `None` to draw a name chip instead.
  pub thumbnail: Option<String>,
  pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerEditBanner {
  pub text: String,
  pub cancel_label: String,
}

/// A mistyped slash command, already split around the suggested command so the
/// native side can set it in mono without parsing anything.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerTypo {
  pub before: String,
  pub command: String,
  pub after: String,
  pub use_label: String,
  pub send_anyway_label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerStrings {
  pub attach: String,
  pub attach_photos: String,
  pub attach_files: String,
  pub remove_attachment: String,
  pub uploading: String,
  pub send: String,
  pub stop: String,
  pub scroll_to_end: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerRequest {
  /// A web modal is open (or there is no chat tab): the composer hides.
  pub hidden: bool,
  pub placeholder: String,
  pub can_send: bool,
  pub turn_in_flight: bool,
  pub attach_enabled: bool,
  pub uploading: bool,
  pub attachments: Vec<ComposerAttachment>,
  pub edit_banner: Option<ComposerEditBanner>,
  pub typo: Option<ComposerTypo>,
  pub strings: ComposerStrings,
  pub theme: ShellTheme,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerTextRequest {
  pub text: String,
}

/// `None` clears the clock (the turn ended).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerElapsedRequest {
  pub label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollToEndRequest {
  pub visible: bool,
  /// Height of the web stack floating above the composer, in points.
  pub accessory_height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAttachmentRequest {
  pub path: String,
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Shared with the web side's `nativeComposerModel.test.ts`, which asserts its
  /// own output equals this file: the camelCase convention can't drift.
  const FIXTURE: &str = include_str!("../tests/fixtures/composer_payload.json");

  #[test]
  fn composer_payload_fixture_deserializes() {
    let request: ComposerRequest = serde_json::from_str(FIXTURE).unwrap();
    assert!(request.can_send);
    assert_eq!(request.attachments.len(), 2);
    assert_eq!(request.attachments[1].thumbnail, None);
    assert_eq!(request.typo.as_ref().unwrap().send_anyway_label, "Send anyway");
    assert_eq!(request.strings.scroll_to_end, "Scroll to bottom");
    assert_eq!(request.theme.primary_foreground, "#ffffff");
  }

  const MENU_FIXTURE: &str = include_str!("../tests/fixtures/top_bar_menu_payload.json");

  #[test]
  fn top_bar_menu_fixture_round_trips_to_the_same_json() {
    let request: TopBarMenuRequest = serde_json::from_str(MENU_FIXTURE).unwrap();
    let model = request.model.as_ref().unwrap();
    assert_eq!(model.options.len(), 2);
    assert_eq!(model.current_id.as_deref(), Some("opus"));
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(MENU_FIXTURE).unwrap());
  }

  #[test]
  fn composer_payload_round_trips_to_the_same_json() {
    let request: ComposerRequest = serde_json::from_str(FIXTURE).unwrap();
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap());
  }
}

/// Where a long-press opens the lifted-preview menu: the bubble's rectangle in
/// web view points, and the items its menu offers.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTargetRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// `rect: None` disarms: a long-press anywhere opens nothing.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTargetRequest {
  pub id: String,
  pub rect: Option<ContextTargetRect>,
  pub items: Vec<ContextMenuItem>,
}
