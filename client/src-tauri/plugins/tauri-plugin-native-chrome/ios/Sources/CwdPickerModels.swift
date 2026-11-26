import SwiftUI
import UIKit

// Payloads for the working directory picker. Like the rest of the shell,
// everything arrives worded and translated. The web side lists folders on the
// relay, resolves typed paths and decides what a pick does; this side owns
// where the sheet is (its stack of folders, the search text, whether hidden
// folders show), since a swipe back is the system's and can't wait for a
// round trip, and reports it.

struct CwdFolderRef: Decodable, Hashable {
  let path: String
  let name: String
  /// The path as shown, with the home folder written `~`.
  let display: String
}

struct CwdFolderEntry: Decodable, Hashable {
  let path: String
  let name: String
  let display: String
  /// A dot-folder or `node_modules`: offered only with "Show hidden folders".
  let hidden: Bool

  var ref: CwdFolderRef { CwdFolderRef(path: path, name: name, display: display) }
}

struct CwdNotice: Decodable {
  let title: String
  let message: String
}

/// One folder's subfolders, as the relay last listed them.
struct CwdFolder: Decodable {
  enum Status: String, Decodable {
    case loading, ready, error
  }

  let status: Status
  /// The folder above, for the "Up to …" row; `nil` at `/`.
  let parent: CwdFolderRef?
  let upLabel: String?
  /// Every subfolder, hidden ones included.
  let entries: [CwdFolderEntry]
  let error: CwdNotice?
}

struct CwdLookupTarget: Decodable {
  let path: String
  let name: String
  let display: String
  let openLabel: String
  /// Every folder from `/` down to this one, itself included.
  let chain: [CwdFolderRef]

  var ref: CwdFolderRef { CwdFolderRef(path: path, name: name, display: display) }
}

/// What the search field's typed path resolved to.
struct CwdLookup: Decodable {
  enum Status: String, Decodable {
    case checking, found, missing
  }

  /// The text this answers: shown only while the field still holds it.
  let query: String
  let status: Status
  let target: CwdLookupTarget?
  let error: CwdNotice?
}

struct CwdCapsuleArgs: Decodable {
  let name: String
  let accessibilityLabel: String
}

struct CwdPickerStrings: Decodable {
  let title: String
  let close: String
  let more: String
  let searchPrompt: String
  let clearSearch: String
  let recents: String
  let browseFromCurrent: String
  let subfolders: String
  let loading: String
  let emptyTitle: String
  let emptyMessage: String
  /// Holds `{query}`, replaced here with the typed text.
  let noMatchTitle: String
  let noMatchMessage: String
  let checking: String
  let retry: String
  let selected: String
  let useFolder: String
  let alreadyCurrent: String
  let showHidden: String
  let goHome: String
}

/// The picker of a conversation whose folder can still be chosen.
struct CwdPickerArgs: Decodable {
  /// Names the conversation. Every event carries it back, and an open sheet
  /// closes when it changes.
  let key: String
  let capsule: CwdCapsuleArgs
  /// Bumped when a folder picked in the sheet takes effect: the capsule
  /// flashes.
  let flash: Int
  /// The conversation's folder: the sheet opens on it.
  let current: CwdFolderRef
  let home: CwdFolderRef?
  /// Recently used folders, the current one left out.
  let recents: [CwdFolderRef]
  /// Listings by path, while the sheet is open.
  let folders: [String: CwdFolder]
  let lookup: CwdLookup?
  let strings: CwdPickerStrings
  let theme: ShellTheme
}

/// `picker == nil`: the folder can't be chosen (fixed after the first
/// message, or not known yet).
struct CwdPickerRequestArgs: Decodable {
  let picker: CwdPickerArgs?
}

// Events sent back to the web side. Each names the conversation it was made
// in (`key`), so the web side can drop one that lands after the picker moved
// to another conversation.

struct CwdKeyEvent: Encodable {
  let key: String
}

struct CwdPathEvent: Encodable {
  let key: String
  let path: String
}

struct CwdLookupEvent: Encodable {
  let key: String
  let query: String
}

/// State behind the capsule above the composer and the working directory
/// sheet: the payload, and where the open sheet is. The plugin wires the
/// reports to events for the web side; the sheet controller handles opening
/// and closing.
@MainActor
final class CwdPickerStore: ObservableObject {
  @Published private(set) var args: CwdPickerArgs?
  /// The last payload there was. The capsule keeps drawing it while it fades
  /// out (the folder was just fixed), and the sheet while it slides away.
  private(set) var lastArgs: CwdPickerArgs?

  /// The folder at the bottom of the sheet's stack: the conversation's
  /// folder when the sheet opens, and its parent after going up from there.
  @Published var root = CwdFolderRef(path: "/", name: "/", display: "/") {
    didSet { topDidChange() }
  }

  /// Folders pushed on top of `root`. Bound to the sheet's navigation stack,
  /// so the system's back button and swipe change it directly.
  @Published var pushed: [CwdFolderRef] = [] {
    didSet { topDidChange() }
  }

  @Published var query = "" {
    didSet { queryDidChange() }
  }

  @Published var showHidden = false

  /// The conversation the open sheet was opened for; `nil` while closed.
  private(set) var openKey: String?
  private var reportedTop: String?
  private var reportedLookup: String?

  /// The folder on screen in the sheet.
  var top: CwdFolderRef { pushed.last ?? root }

  /// The search text as the web side receives it.
  var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// Same rule as the web side's `isPathQuery`: a path rather than a name.
  var isPathQuery: Bool { trimmedQuery.hasPrefix("/") || trimmedQuery.hasPrefix("~") }

  /// Wired by the sheet controller.
  var onPresent: () -> Void = {}
  var onDismiss: () -> Void = {}
  var onSearchFocus: () -> Void = {}

  /// Reports, wired by the plugin to events. Each carries the open sheet's
  /// conversation key.
  var reportOpen: (String) -> Void = { _ in }
  var reportFolder: (String, String) -> Void = { _, _ in }
  var reportRetry: (String, String) -> Void = { _, _ in }
  var reportLookup: (String, String) -> Void = { _, _ in }
  var reportChoose: (String, String) -> Void = { _, _ in }
  var reportClose: (String) -> Void = { _ in }

  /// Takes a payload in. Returns whether an open sheet has to close: the
  /// folder can't be chosen anymore, or the payload is another
  /// conversation's.
  func apply(_ next: CwdPickerArgs?) -> Bool {
    args = next
    if let next { lastArgs = next }
    guard let openKey else { return false }
    return next?.key != openKey
  }

  /// The capsule was tapped. The controller won't open a second sheet over
  /// one that is up.
  func requestOpen() {
    guard args != nil else { return }
    onPresent()
  }

  /// The sheet is about to open: it starts on the conversation's folder, with
  /// nothing typed and hidden folders left out.
  func begin() {
    guard let args else { return }
    openKey = nil
    pushed = []
    root = args.current
    query = ""
    showHidden = false
    reportedTop = nil
    reportedLookup = nil
    openKey = args.key
    reportOpen(args.key)
    topDidChange()
  }

  /// The sheet went away: pulled down, closed, a folder picked, or the
  /// picker taken away.
  func end() {
    guard let key = openKey else { return }
    openKey = nil
    reportClose(key)
  }

  // MARK: Where the sheet is

  /// A folder came on screen: the web side lists it, and the search starts
  /// over, as in a fresh folder.
  private func topDidChange() {
    guard let key = openKey else { return }
    let path = top.path
    guard path != reportedTop else { return }
    reportedTop = path
    if !query.isEmpty { query = "" }
    reportFolder(key, path)
  }

  private func queryDidChange() {
    guard let key = openKey, isPathQuery else { return }
    let text = trimmedQuery
    guard text != reportedLookup else { return }
    reportedLookup = text
    reportLookup(key, text)
  }

  func folder(_ path: String) -> CwdFolder? {
    (args ?? lastArgs)?.folders[path]
  }

  /// Every move through the stack goes through here: the search field's
  /// keyboard goes with the screen it was typed on, as in the Files app.
  private func navigate(_ change: () -> Void) {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    change()
  }

  /// A subfolder was tapped.
  func open(_ folder: CwdFolderRef) {
    navigate { pushed.append(folder) }
  }

  /// The "Up to …" row. Steps back when the screen below is the folder above;
  /// otherwise (the bottom of the stack, or a folder reached by typing its
  /// path) puts the folder above in this one's place.
  func goUp() {
    guard let parent = folder(top.path)?.parent else { return }
    navigate {
      if pushed.isEmpty {
        root = parent
      } else if (pushed.dropLast().last ?? root).path == parent.path {
        pushed.removeLast()
      } else {
        pushed[pushed.count - 1] = parent
      }
    }
  }

  /// Goes to a typed path the relay confirmed. Below the folder the stack
  /// starts on, the folders in between are stacked too, so back walks up
  /// from it; anywhere else it goes right on top.
  func goTo(_ target: CwdLookupTarget) {
    navigate {
      if target.path == root.path {
        pushed = []
      } else if let start = target.chain.firstIndex(where: { $0.path == root.path }) {
        pushed = Array(target.chain[(start + 1)...])
      } else {
        pushed = [target.ref]
      }
    }
  }

  func goHome() {
    guard let home = (args ?? lastArgs)?.home else { return }
    navigate { pushed = home.path == root.path ? [] : [home] }
  }

  /// Return in the search field: a typed path goes to its folder once the
  /// relay found it; a name opens the first folder it matches.
  func submitSearch() {
    if isPathQuery {
      guard let lookup = args?.lookup, lookup.query == trimmedQuery, let target = lookup.target else { return }
      goTo(target)
    } else if let folder = folder(top.path), folder.status == .ready, let first = visibleEntries(folder).first {
      open(first.ref)
    }
  }

  func retry(_ path: String) {
    guard let key = openKey else { return }
    reportRetry(key, path)
  }

  /// A recent folder, or "Use this folder": the web side decides what it
  /// does, the sheet closes right away.
  func choose(_ path: String) {
    guard let key = openKey else { return }
    reportChoose(key, path)
    onDismiss()
  }

  // MARK: What the sheet shows

  /// The subfolders left after the hidden-folders toggle and the search.
  func visibleEntries(_ folder: CwdFolder) -> [CwdFolderEntry] {
    let needle = isPathQuery ? "" : trimmedQuery.lowercased()
    return folder.entries.filter { entry in
      (showHidden || !entry.hidden) && (needle.isEmpty || entry.name.lowercased().contains(needle))
    }
  }

  /// The recent folders the search leaves.
  func visibleRecents(_ args: CwdPickerArgs) -> [CwdFolderRef] {
    let needle = trimmedQuery.lowercased()
    guard !needle.isEmpty else { return args.recents }
    return args.recents.filter { $0.name.lowercased().contains(needle) }
  }
}
