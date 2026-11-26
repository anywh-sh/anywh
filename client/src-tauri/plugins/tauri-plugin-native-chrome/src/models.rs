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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarModeOption {
  pub id: String,
  pub label: String,
  /// One-line explanation shown under the label; empty when there is none.
  pub hint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarModeMenu {
  pub label: String,
  pub current_id: Option<String>,
  pub current_label: String,
  pub options: Vec<TopBarModeOption>,
  pub enabled: bool,
}

/// Reasoning-effort entry of the dropdown. Never locked. When the CLI reports
/// no default effort, the first option is the "no pick" row (id `default`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarEffortMenu {
  pub label: String,
  pub current_id: Option<String>,
  pub current_label: String,
  pub options: Vec<TopBarMenuOption>,
  pub enabled: bool,
}

/// Agent entry of the dropdown: offered only when the relay runs more than one
/// agent, and locked exactly when the model is (after the first turn).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarAgentMenu {
  pub label: String,
  pub current_id: Option<String>,
  pub current_label: String,
  pub options: Vec<TopBarMenuOption>,
  pub locked: bool,
  pub locked_hint: String,
  pub enabled: bool,
}

/// The conversation's working directory once the first message fixed it, at
/// the top of the dropdown: the capsule above the composer is gone by then.
/// Only shown, never picked.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarCwdEntry {
  /// The section's label ("Working directory").
  pub label: String,
  pub name: String,
  /// The path as shown, with the home folder written `~`.
  pub path: String,
}

/// Contents of the dropdown the top bar's center opens. Each entry is `None`
/// when there is nothing to offer for it; with all `None` the bar stays a
/// plain label.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBarMenuRequest {
  pub model: Option<TopBarModelMenu>,
  pub mode: Option<TopBarModeMenu>,
  pub effort: Option<TopBarEffortMenu>,
  /// Absent from a web build older than the agent entry.
  #[serde(default)]
  pub agent: Option<TopBarAgentMenu>,
  /// Absent from a web build older than the working directory entry.
  #[serde(default)]
  pub cwd: Option<TopBarCwdEntry>,
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

/// A bot of the drawer's Bots section, drawn and written by the web side: its
/// face is 256 characters, row by row, `.` empty and `a`, `b`, ... the first,
/// second, ... color of `mascot_palette`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerBot {
  pub id: String,
  pub room_id: String,
  pub name: String,
  pub line: String,
  pub tone: String,
  pub mascot: String,
  pub mascot_palette: Vec<String>,
  pub badge: Option<String>,
  pub selected: bool,
}

/// The drawer's Bots and Conversations sections, which take turns.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawerBots {
  pub section: String,
  pub bots_label: String,
  pub conversations_label: String,
  pub new_bot_label: String,
  pub empty_title: String,
  pub empty_body: String,
  pub waiting_label: String,
  pub items: Vec<DrawerBot>,
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
  /// Absent from a web build without bots. Typed here because this struct is
  /// what reaches Swift: a field it does not declare is dropped on the way.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub bots: Option<DrawerBots>,
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
  /// `"image"`, `"video"` or `"file"`; only `"video"` is told apart natively.
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

/// The pending question's row inside the composer, which opens the sheet.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceBanner {
  /// "Pending question" / "Approval needed"; the position travels apart, in
  /// `ChoiceSheet::position`.
  pub label: String,
  /// The question, shown on one line.
  pub text: String,
  /// Accessibility label of the row.
  pub open_label: String,
}

/// One option of the question on screen, already worded and translated.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOptionRow {
  pub label: String,
  pub description: Option<String>,
  pub selected: bool,
}

/// The free-text answer field, when the question takes one.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceCustomField {
  /// Applied to the field only when `ChoiceSheet::step_key` changes, so a
  /// payload never overwrites what is being typed.
  pub text: String,
  pub placeholder: String,
  pub label: String,
  /// Mask the field (a secure text entry).
  pub secret: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceStrings {
  pub close: String,
  pub previous: String,
}

/// One step (question) of a pending prompt, as the native sheet draws it. The
/// web side owns the answer being built and resends this after every change;
/// the native side reports taps and typing back as events.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceSheet {
  /// Identifies the question on screen; a new one resets the free-text field
  /// and the scroll position.
  pub step_key: String,
  pub banner: ChoiceBanner,
  /// Small label above the question: its header, or the kind of prompt.
  pub kicker: String,
  /// "1 of 3", only when the prompt has more than one question.
  pub position: Option<String>,
  pub question: String,
  pub multi_select: bool,
  pub options: Vec<ChoiceOptionRow>,
  /// Free text was typed: it is the answer, the options step back.
  pub options_dimmed: bool,
  pub custom: Option<ChoiceCustomField>,
  pub can_go_back: bool,
  /// `false` while the relay can't be reached: nothing can be answered.
  pub can_answer: bool,
  /// Why answering is held back, or `None`.
  pub status: Option<String>,
  pub submit_label: String,
  pub skip_label: String,
  pub strings: ChoiceStrings,
  pub theme: ShellTheme,
}

/// `choice: None` means no question is pending: the composer row goes away
/// and an open sheet closes.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceRequest {
  pub choice: Option<ChoiceSheet>,
}

/// A folder as the working directory picker shows it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdFolderRef {
  pub path: String,
  pub name: String,
  /// The path as shown, with the home folder written `~`.
  pub display: String,
}

/// One subfolder of a listed folder.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdFolderEntry {
  pub path: String,
  pub name: String,
  pub display: String,
  /// A dot-folder or `node_modules`: offered only with "Show hidden folders".
  pub hidden: bool,
}

/// A worded reason, for a folder the relay couldn't list or a typed path it
/// couldn't find.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdNotice {
  pub title: String,
  pub message: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CwdFolderStatus {
  Loading,
  Ready,
  Error,
}

/// One folder's subfolders, as the relay last listed them.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdFolder {
  pub status: CwdFolderStatus,
  /// The folder above, for the "Up to ..." row; `None` at `/`.
  pub parent: Option<CwdFolderRef>,
  pub up_label: Option<String>,
  /// Every subfolder, hidden ones included.
  pub entries: Vec<CwdFolderEntry>,
  pub error: Option<CwdNotice>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CwdLookupStatus {
  Checking,
  Found,
  Missing,
}

/// A typed path the relay confirmed is a folder.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdLookupTarget {
  pub path: String,
  pub name: String,
  pub display: String,
  /// "Open <name>".
  pub open_label: String,
  /// Every folder from `/` down to this one, itself included, so going there
  /// can stack the folders in between.
  pub chain: Vec<CwdFolderRef>,
}

/// What the search field's typed path resolved to.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdLookup {
  /// The text this answers: the sheet only shows it while the field still
  /// holds exactly this.
  pub query: String,
  pub status: CwdLookupStatus,
  pub target: Option<CwdLookupTarget>,
  pub error: Option<CwdNotice>,
}

/// The capsule above the composer that opens the sheet.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdCapsule {
  pub name: String,
  pub accessibility_label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdPickerStrings {
  pub title: String,
  pub close: String,
  pub more: String,
  pub search_prompt: String,
  /// Accessibility label of the search field's clear button.
  pub clear_search: String,
  pub recents: String,
  pub browse_from_current: String,
  pub subfolders: String,
  pub loading: String,
  pub empty_title: String,
  pub empty_message: String,
  /// Holds `{query}`, which the sheet replaces with the typed text.
  pub no_match_title: String,
  pub no_match_message: String,
  pub checking: String,
  pub retry: String,
  pub selected: String,
  pub use_folder: String,
  pub already_current: String,
  pub show_hidden: String,
  pub go_home: String,
}

/// The working directory picker of a conversation whose folder can still be
/// chosen. The web side lists folders, resolves typed paths and decides what
/// a pick does; the native side owns where the sheet is (its stack of
/// folders, the search text, whether hidden folders show) and reports it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdPicker {
  /// Names the conversation. Every event carries it back, and an open sheet
  /// closes when it changes.
  pub key: String,
  pub capsule: CwdCapsule,
  /// Bumped when a folder picked in the sheet takes effect: the capsule
  /// flashes.
  pub flash: u32,
  /// The conversation's folder: the sheet opens on it.
  pub current: CwdFolderRef,
  /// The home folder on the relay's machine, once known.
  pub home: Option<CwdFolderRef>,
  /// Recently used folders, the current one left out.
  pub recents: Vec<CwdFolderRef>,
  /// Listings by path, while the sheet is open.
  pub folders: std::collections::BTreeMap<String, CwdFolder>,
  pub lookup: Option<CwdLookup>,
  pub strings: CwdPickerStrings,
  pub theme: ShellTheme,
}

/// `picker: None` means the folder can't be chosen (it is fixed after the
/// first message, or not known yet): the capsule goes away and an open sheet
/// closes.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdPickerRequest {
  pub picker: Option<CwdPicker>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAttachmentRequest {
  pub path: String,
}

/// The APNs device token (lowercase hex) and the APNs environment it is valid
/// for. A sandbox token is rejected by the production gateway and vice versa,
/// so whoever sends the push has to know which one this build got.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRegistration {
  pub token: String,
  pub environment: PushEnvironment,
}

/// Which session is on screen right now, so a push about it is not shown in
/// the foreground. `None` when nothing is.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VisibleSessionRequest {
  pub session_id: Option<String>,
}

/// Where a tapped push notification should take the app. `profile_id` is the
/// profile id on this device, as the app registered it with the relay.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushTap {
  pub session_id: String,
  pub profile_id: Option<String>,
}

/// Answer of `take_pending_push_tap`: an object even when empty, so "nothing
/// pending" is `{"tap": null}` and not a bare null.
#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingPushTap {
  pub tap: Option<PushTap>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PushEnvironment {
  Sandbox,
  Production,
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
    assert_eq!(request.mode.as_ref().unwrap().options.len(), 2);
    let effort = request.effort.as_ref().unwrap();
    assert_eq!(effort.current_id.as_deref(), Some("high"));
    assert_eq!(effort.options.len(), 4);
    let agent = request.agent.as_ref().unwrap();
    assert_eq!(agent.current_id.as_deref(), Some("claude"));
    assert_eq!(agent.options.len(), 2);
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(MENU_FIXTURE).unwrap());
  }

  #[test]
  fn top_bar_menu_without_an_agent_entry_still_decodes() {
    let request: TopBarMenuRequest = serde_json::from_str(r#"{"model":null,"mode":null,"effort":null}"#).unwrap();
    assert!(request.agent.is_none());
    assert!(request.cwd.is_none());
  }

  /// The web side's menu once the first message fixed the model, the agent
  /// and the folder (`nativeTopBarMenuModel.test.ts` checks it).
  const LOCKED_MENU_FIXTURE: &str = include_str!("../tests/fixtures/top_bar_menu_locked_payload.json");

  #[test]
  fn locked_top_bar_menu_keeps_its_working_directory_on_the_way_to_swift() {
    let request: TopBarMenuRequest = serde_json::from_str(LOCKED_MENU_FIXTURE).unwrap();
    let cwd = request.cwd.as_ref().unwrap();
    assert_eq!(cwd.name, "anywh");
    assert_eq!(cwd.path, "~/anywh/anywh");
    assert!(request.model.as_ref().is_some_and(|model| model.locked));
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(LOCKED_MENU_FIXTURE).unwrap());
  }

  #[test]
  fn push_registration_matches_the_swift_wire_format() {
    let parsed: PushRegistration = serde_json::from_str(r#"{"token":"ab12","environment":"sandbox"}"#).unwrap();
    assert_eq!(parsed.token, "ab12");
    assert_eq!(parsed.environment, PushEnvironment::Sandbox);
    let production: PushRegistration = serde_json::from_str(r#"{"token":"cd34","environment":"production"}"#).unwrap();
    assert_eq!(production.environment, PushEnvironment::Production);
  }

  #[test]
  fn push_tap_types_match_the_swift_wire_format() {
    let tap: PendingPushTap =
      serde_json::from_str(r#"{"tap":{"sessionId":"s1","profileId":"p1"}}"#).unwrap();
    assert_eq!(
      tap.tap,
      Some(PushTap { session_id: "s1".into(), profile_id: Some("p1".into()) })
    );
    let no_profile: PendingPushTap = serde_json::from_str(r#"{"tap":{"sessionId":"s1"}}"#).unwrap();
    assert_eq!(no_profile.tap.unwrap().profile_id, None);
    let empty: PendingPushTap = serde_json::from_str(r#"{"tap":null}"#).unwrap();
    assert_eq!(empty, PendingPushTap::default());
    assert_eq!(serde_json::to_string(&empty).unwrap(), r#"{"tap":null}"#);
  }

  #[test]
  fn visible_session_request_accepts_a_session_or_none() {
    let some: VisibleSessionRequest = serde_json::from_str(r#"{"sessionId":"s1"}"#).unwrap();
    assert_eq!(some.session_id.as_deref(), Some("s1"));
    let none: VisibleSessionRequest = serde_json::from_str(r#"{"sessionId":null}"#).unwrap();
    assert_eq!(none.session_id, None);
    let absent: VisibleSessionRequest = serde_json::from_str(r#"{}"#).unwrap();
    assert_eq!(absent.session_id, None);
    assert_eq!(serde_json::to_string(&some).unwrap(), r#"{"sessionId":"s1"}"#);
  }

  const DRAWER_FIXTURE: &str = include_str!("../tests/fixtures/drawer_payload.json");

  #[test]
  fn drawer_payload_keeps_its_bots_on_the_way_to_swift() {
    // The web side's own output (`nativeShellModel.test.ts` checks it): a
    // field this struct does not declare would be dropped before Swift.
    let request: DrawerRequest = serde_json::from_str(DRAWER_FIXTURE).unwrap();
    assert_eq!(request.bots.as_ref().map(|bots| bots.items.len()), Some(1));
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(DRAWER_FIXTURE).unwrap());
  }

  #[test]
  fn drawer_payload_without_bots_still_decodes_and_sends_none() {
    let mut value: serde_json::Value = serde_json::from_str(DRAWER_FIXTURE).unwrap();
    value.as_object_mut().unwrap().remove("bots");
    let request: DrawerRequest = serde_json::from_value(value.clone()).unwrap();
    assert!(request.bots.is_none());
    assert_eq!(serde_json::to_value(&request).unwrap(), value);
  }

  #[test]
  fn composer_payload_round_trips_to_the_same_json() {
    let request: ComposerRequest = serde_json::from_str(FIXTURE).unwrap();
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap());
  }

  /// Shared with the web side's `nativeChoiceModel.test.ts`, which asserts its
  /// own output equals this file: a field this struct does not declare would be
  /// dropped before Swift.
  const CHOICE_FIXTURE: &str = include_str!("../tests/fixtures/choice_payload.json");

  #[test]
  fn choice_payload_round_trips_to_the_same_json() {
    let request: ChoiceRequest = serde_json::from_str(CHOICE_FIXTURE).unwrap();
    let sheet = request.choice.as_ref().unwrap();
    assert_eq!(sheet.options.len(), 3);
    assert!(sheet.options[0].selected);
    assert_eq!(sheet.options[2].description, None);
    assert_eq!(sheet.position.as_deref(), Some("1 of 2"));
    assert!(sheet.custom.as_ref().is_some_and(|custom| !custom.secret));
    assert_eq!(sheet.status, None);
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(CHOICE_FIXTURE).unwrap());
  }

  #[test]
  fn no_pending_choice_is_a_null_choice() {
    let request: ChoiceRequest = serde_json::from_str(r#"{"choice":null}"#).unwrap();
    assert!(request.choice.is_none());
    assert_eq!(serde_json::to_string(&request).unwrap(), r#"{"choice":null}"#);
  }

  /// Shared with the web side's `nativeCwdPickerModel.test.ts`, which asserts
  /// its own output equals this file: a field this struct does not declare
  /// would be dropped before Swift.
  const CWD_PICKER_FIXTURE: &str = include_str!("../tests/fixtures/cwd_picker_payload.json");

  #[test]
  fn cwd_picker_payload_round_trips_to_the_same_json() {
    let request: CwdPickerRequest = serde_json::from_str(CWD_PICKER_FIXTURE).unwrap();
    let picker = request.picker.as_ref().unwrap();
    assert_eq!(picker.recents.len(), 2);
    let current = &picker.folders[&picker.current.path];
    assert_eq!(current.status, CwdFolderStatus::Ready);
    assert!(current.entries.iter().any(|entry| entry.hidden));
    assert_eq!(picker.folders.values().filter(|folder| folder.status == CwdFolderStatus::Error).count(), 1);
    let lookup = picker.lookup.as_ref().unwrap();
    assert_eq!(lookup.status, CwdLookupStatus::Found);
    assert_eq!(lookup.target.as_ref().unwrap().chain.first().map(|folder| folder.path.as_str()), Some("/"));
    let again = serde_json::to_value(&request).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(CWD_PICKER_FIXTURE).unwrap());
  }

  #[test]
  fn no_choosable_folder_is_a_null_picker() {
    let request: CwdPickerRequest = serde_json::from_str(r#"{"picker":null}"#).unwrap();
    assert!(request.picker.is_none());
    assert_eq!(serde_json::to_string(&request).unwrap(), r#"{"picker":null}"#);
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
