import SwiftUI
import UIKit

// Payloads sent by the web side. Everything arrives formatted and localized;
// nothing here decides or translates, it only carries values to the views.

struct ShellTheme: Decodable {
  let background: String
  let sidebar: String
  let elevated: String
  let card: String
  let foreground: String
  let muted: String
  let faint: String
  let border: String
  let primary: String
  let destructive: String
  let tint: String
  let success: String

  static let fallback = ShellTheme(
    background: "#1b1a18", sidebar: "#222120", elevated: "#2a2826", card: "#222120",
    foreground: "#eceae4", muted: "#b1aba2", faint: "#9d978f", border: "#332f2c",
    primary: "#e0642a", destructive: "#dc6f5c", tint: "#eceae4", success: "#e0642a")
}

struct TopBarArgs: Decodable {
  let title: String
  let modelLabel: String?
  let connected: Bool
  let openSidebarLabel: String
  let newConversationLabel: String
  let connectionLabel: String
  let theme: ShellTheme
}

struct DrawerStrings: Decodable {
  let allChats: String
  let loadFailed: String
  let retry: String
  let emptyTitle: String
  let emptyBody: String
  let rename: String
  let renameTitle: String
  let renameDescription: String
  let delete: String
  let deleteTitle: String
  let deleteBody: String
  let cancel: String
  let save: String
  let agentWorking: String
  let backgroundJob: String
}

struct DrawerProfile: Decodable, Identifiable {
  let id: String
  let label: String
  let color: String
}

struct DrawerSession: Decodable, Identifiable {
  let id: String
  let profileId: String
  let title: String
  let meta: String
  let color: String
  let running: Bool
  let backgroundJob: Bool
  let selected: Bool

  var rowId: String { "\(profileId):\(id)" }
}

struct DrawerGroup: Decodable, Identifiable {
  let id: String
  let label: String
  let sessions: [DrawerSession]
}

struct DrawerArgs: Decodable {
  let theme: ShellTheme
  let strings: DrawerStrings
  let profiles: [DrawerProfile]
  let activeProfileId: String
  let loading: Bool
  let error: Bool
  let hasMore: Bool
  let groups: [DrawerGroup]
}

struct GestureHintArgs: Decodable {
  let blocked: Bool
}

// Events sent back to the web side.

struct SessionEvent: Encodable {
  let sessionId: String
  let profileId: String
}

struct RenameEvent: Encodable {
  let sessionId: String
  let profileId: String
  let title: String
}

struct ProfileEvent: Encodable {
  let profileId: String
}

extension UIColor {
  /// `#rrggbb` or `#rrggbbaa`; anything else falls back to clear.
  convenience init(hex: String) {
    var digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    if digits.count == 6 { digits += "ff" }
    guard digits.count == 8, let value = UInt32(digits, radix: 16) else {
      self.init(white: 0, alpha: 0)
      return
    }
    self.init(
      red: CGFloat((value >> 24) & 0xff) / 255,
      green: CGFloat((value >> 16) & 0xff) / 255,
      blue: CGFloat((value >> 8) & 0xff) / 255,
      alpha: CGFloat(value & 0xff) / 255)
  }

  /// Perceived brightness below one half — used to pick the system material style.
  var isDark: Bool {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return 0.299 * red + 0.587 * green + 0.114 * blue < 0.5
  }
}

extension Color {
  init(hex: String) {
    self.init(uiColor: UIColor(hex: hex))
  }
}

/// Observable state behind the top bar pill.
@MainActor
final class TopBarStore: ObservableObject {
  @Published var args: TopBarArgs?
  var onMenu: () -> Void = {}
  var onNewConversation: () -> Void = {}
}

/// Observable state behind the conversation drawer, plus the actions its
/// views report. The plugin wires the actions to events for the web side.
@MainActor
final class DrawerStore: ObservableObject {
  @Published var args: DrawerArgs?
  var onSelect: (DrawerSession) -> Void = { _ in }
  var onProfileChange: (String) -> Void = { _ in }
  var onAllChats: () -> Void = {}
  var onRetry: () -> Void = {}
  var onRename: (DrawerSession, String) -> Void = { _, _ in }
  var onDelete: (DrawerSession) -> Void = { _ in }
}
