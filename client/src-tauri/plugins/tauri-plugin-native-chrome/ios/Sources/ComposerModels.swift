import SwiftUI
import UIKit

// Payloads for the native composer. Like the rest of the shell, everything
// arrives formatted and localized; nothing here decides or translates.

struct ComposerAttachment: Decodable, Identifiable {
  let path: String
  let kind: String
  let thumbnail: String?
  let name: String

  var id: String { path }
  var isVideo: Bool { kind == "video" }
}

struct ComposerEditBanner: Decodable {
  let text: String
  let cancelLabel: String
}

struct ComposerTypo: Decodable {
  let before: String
  let command: String
  let after: String
  let useLabel: String
  let sendAnywayLabel: String
}

struct ComposerStrings: Decodable {
  let attach: String
  let attachPhotos: String
  let attachFiles: String
  let removeAttachment: String
  let uploading: String
  let send: String
  let stop: String
  let scrollToEnd: String
}

struct ComposerArgs: Decodable {
  let hidden: Bool
  let placeholder: String
  let canSend: Bool
  let turnInFlight: Bool
  let attachEnabled: Bool
  let uploading: Bool
  let attachments: [ComposerAttachment]
  let editBanner: ComposerEditBanner?
  let typo: ComposerTypo?
  let strings: ComposerStrings
  let theme: ShellTheme
}

struct ComposerTextArgs: Decodable {
  let text: String
}

struct ComposerElapsedArgs: Decodable {
  let label: String?
}

struct ScrollToEndArgs: Decodable {
  let visible: Bool
  let accessoryHeight: Double
}

// Events sent back to the web side.

struct ComposerTextEvent: Encodable {
  let text: String
}

struct ComposerFocusEvent: Encodable {
  let focused: Bool
}

struct ComposerRemoveEvent: Encodable {
  let path: String
}

struct AttachedFile: Encodable, Sendable {
  let path: String
  let name: String
  let mimeType: String
}

struct ComposerAttachEvent: Encodable {
  let files: [AttachedFile]
}

/// Observable state behind the composer and the scroll-to-end button, plus the
/// actions their views report. The plugin wires the actions to events for the
/// web side.
@MainActor
final class ComposerStore: ObservableObject {
  @Published var args: ComposerArgs?
  /// Turn clock label, formatted by the web side; `nil` while no turn runs.
  @Published var elapsed: String?
  @Published var scrollToEndVisible = false
  /// The text field's content wraps onto more than one line.
  @Published var multiline = false
  /// How tall the text field may grow before it scrolls inside itself.
  @Published var maxFieldHeight: CGFloat = 160
  @Published var focused = false

  /// The field itself. The text lives only there: the web side hears about
  /// edits, and sends text back imperatively when it needs to change it.
  weak var textView: ComposerUITextView?
  /// Text and focus requested before the field exists (the view is created the
  /// first time a payload arrives); applied as soon as it is.
  var pendingText: String?
  var pendingFocus = false

  var onTextChange: (String) -> Void = { _ in }
  var onFocusChange: (Bool) -> Void = { _ in }
  var onSubmit: (String) -> Void = { _ in }
  var onStop: () -> Void = {}
  var onAttachPhotos: () -> Void = {}
  var onAttachFiles: () -> Void = {}
  var onRemoveAttachment: (String) -> Void = { _ in }
  var onCancelEdit: () -> Void = {}
  var onTypoUse: () -> Void = {}
  var onTypoSendAnyway: () -> Void = {}
  var onScrollToEnd: () -> Void = {}
  var onPastedImages: ([AttachedFile]) -> Void = { _ in }
}
