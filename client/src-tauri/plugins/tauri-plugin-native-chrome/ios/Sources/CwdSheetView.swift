import SwiftUI
import UIKit

/// Tunables for the working directory sheet, in one place for on-device tuning.
private enum CwdSheetTuning {
  static let rowMinHeight: CGFloat = 52
  static let buttonHeight: CGFloat = 52
  static let iconWidth: CGFloat = 26
  /// The rows' surface over the sheet's own.
  static let cellOpacity: Double = 0.06
  /// Widths of the loading rows' name bars, as shares of 200pt.
  static let skeletonWidths: [CGFloat] = [0.52, 0.38, 0.64, 0.44]
}

/// The working directory sheet: folders on the relay's machine, browsed like
/// the Files app. It opens on the conversation's folder, with the recent
/// folders on top (one tap picks one) and the subfolders below; tapping a
/// folder pushes its subfolders, and the system's back button walks back. The
/// search field filters the folder on screen, or goes straight to a pasted
/// path; the "…" menu shows hidden folders or goes to the home folder; and
/// "Use this folder" picks the folder on screen. Everything it shows comes
/// worded from the web side; where it is (the stack, the search, the hidden
/// folders toggle) is the store's.
struct CwdSheetView: View {
  @ObservedObject var store: CwdPickerStore

  var body: some View {
    if let args = store.args ?? store.lastArgs {
      NavigationStack(path: $store.pushed) {
        CwdFolderScreen(store: store, folder: store.root, isRoot: true)
          // Going up from the bottom of the stack replaces it: start that
          // folder at its top, not at the scroll position of the last one.
          .id(store.root.path)
          .navigationDestination(for: CwdFolderRef.self) { folder in
            CwdFolderScreen(store: store, folder: folder, isRoot: false)
          }
      }
      // The system's controls (back, the toolbar, the menu's checkmark) take
      // the theme's ink; the folders and the main button carry the accent.
      .tint(Color(hex: args.theme.foreground))
    }
  }
}

/// One folder of the stack.
private struct CwdFolderScreen: View {
  @ObservedObject var store: CwdPickerStore
  let folder: CwdFolderRef
  /// The bottom of the stack: titled after the sheet, with the recent folders.
  let isRoot: Bool
  @FocusState private var searchFocused: Bool

  var body: some View {
    if let args = store.args ?? store.lastArgs {
      let strings = args.strings
      List {
        if store.isPathQuery {
          Section { lookupRows(args) }
        } else {
          let recents = isRoot ? store.visibleRecents(args) : []
          if !recents.isEmpty {
            Section {
              ForEach(recents, id: \.path) { recentRow($0, args.theme) }
            } header: {
              sectionHeader(strings.recents, path: nil, args.theme)
            }
          }
          Section {
            folderRows(args)
          } header: {
            sectionHeader(isRoot && folder.path == args.current.path ? strings.browseFromCurrent : strings.subfolders, path: folder.display, args.theme)
          }
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .navigationTitle(isRoot ? strings.title : folder.name)
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(strings.searchPrompt))
      .searchFocused($searchFocused)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .onSubmit(of: .search) { store.submitSearch() }
      // Typing at the half height left the keyboard over the list.
      .onChange(of: searchFocused) { _, focused in
        if focused { store.onSearchFocus() }
      }
      .toolbar { toolbar(args) }
      .pinnedFooter { footer(args) }
    }
  }

  // MARK: Toolbar

  @ToolbarContentBuilder
  private func toolbar(_ args: CwdPickerArgs) -> some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Toggle(isOn: $store.showHidden) {
          Label(args.strings.showHidden, systemImage: "eye")
        }
        if args.home != nil {
          Button {
            store.goHome()
          } label: {
            Label(args.strings.goHome, systemImage: "house")
          }
        }
      } label: {
        Image(systemName: "ellipsis")
      }
      .accessibilityLabel(args.strings.more)
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        store.onDismiss()
      } label: {
        Image(systemName: "xmark")
      }
      .accessibilityLabel(args.strings.close)
    }
  }

  // MARK: Rows

  private func sectionHeader(_ label: String, path: String?, _ theme: ShellTheme) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Color(hex: theme.muted))
      if let path {
        Text(path)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(Color(hex: theme.faint))
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .textCase(nil)
  }

  private func cell(_ theme: ShellTheme) -> Color {
    Color(hex: theme.foreground).opacity(CwdSheetTuning.cellOpacity)
  }

  /// A recent folder: one tap picks it.
  private func recentRow(_ recent: CwdFolderRef, _ theme: ShellTheme) -> some View {
    Button {
      store.choose(recent.path)
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "clock")
          .font(.system(size: 17))
          .foregroundStyle(Color(hex: theme.faint))
          .frame(width: CwdSheetTuning.iconWidth)
        VStack(alignment: .leading, spacing: 1) {
          Text(recent.name)
            .font(.system(size: 16))
            .foregroundStyle(Color(hex: theme.foreground))
            .lineLimit(1)
          Text(recent.display)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(Color(hex: theme.faint))
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer(minLength: 0)
      }
      .frame(minHeight: CwdSheetTuning.rowMinHeight)
      .contentShape(Rectangle())
    }
    .listRowBackground(cell(theme))
  }

  @ViewBuilder
  private func folderRows(_ args: CwdPickerArgs) -> some View {
    let theme = args.theme
    switch store.folder(folder.path)?.status {
    case .ready?:
      if let listing = store.folder(folder.path) {
        if let parent = listing.parent, let upLabel = listing.upLabel, store.trimmedQuery.isEmpty {
          Button {
            store.goUp()
          } label: {
            HStack(spacing: 12) {
              Image(systemName: "arrow.turn.left.up")
                .font(.system(size: 17))
                .foregroundStyle(Color(hex: theme.faint))
                .frame(width: CwdSheetTuning.iconWidth)
              Text(upLabel)
                .font(.system(size: 16))
                .foregroundStyle(Color(hex: theme.foreground))
                .lineLimit(1)
              Spacer(minLength: 0)
            }
            .frame(minHeight: CwdSheetTuning.rowMinHeight)
            .contentShape(Rectangle())
          }
          .accessibilityHint(parent.display)
          .listRowBackground(cell(theme))
        }
        let entries = store.visibleEntries(listing)
        ForEach(entries, id: \.path) { entry in
          NavigationLink(value: entry.ref) {
            HStack(spacing: 12) {
              Image(systemName: "folder")
                .font(.system(size: 18))
                .foregroundStyle(Color(hex: entry.hidden ? theme.faint : theme.primary))
                .frame(width: CwdSheetTuning.iconWidth)
              Text(entry.name)
                .font(.system(size: 16))
                .foregroundStyle(Color(hex: entry.hidden ? theme.faint : theme.foreground))
                .lineLimit(1)
                .truncationMode(.middle)
            }
            .frame(minHeight: CwdSheetTuning.rowMinHeight)
          }
          .listRowBackground(cell(theme))
        }
        if entries.isEmpty {
          if store.trimmedQuery.isEmpty {
            notice(icon: "folder", tint: theme.faint, title: args.strings.emptyTitle, message: args.strings.emptyMessage, action: nil, theme)
          } else {
            notice(
              icon: nil, tint: theme.faint,
              title: args.strings.noMatchTitle.replacingOccurrences(of: "{query}", with: store.trimmedQuery),
              message: args.strings.noMatchMessage, action: nil, theme)
          }
        }
      }
    case .error?:
      let error = store.folder(folder.path)?.error
      notice(
        icon: "exclamationmark.triangle", tint: theme.destructive,
        title: error?.title ?? "", message: error?.message ?? "",
        action: (label: args.strings.retry, run: { store.retry(folder.path) }), theme)
    case .loading?, nil:
      CwdSkeletonRows(theme: theme, label: args.strings.loading)
        .listRowBackground(cell(theme))
    }
  }

  @ViewBuilder
  private func lookupRows(_ args: CwdPickerArgs) -> some View {
    let theme = args.theme
    if let lookup = args.lookup, lookup.query == store.trimmedQuery, lookup.status != .checking {
      if let target = lookup.target {
        Button {
          store.goTo(target)
        } label: {
          HStack(spacing: 12) {
            Image(systemName: "folder")
              .font(.system(size: 18))
              .foregroundStyle(Color(hex: theme.primary))
              .frame(width: CwdSheetTuning.iconWidth)
            VStack(alignment: .leading, spacing: 1) {
              Text(target.openLabel)
                .font(.system(size: 16))
                .foregroundStyle(Color(hex: theme.foreground))
                .lineLimit(1)
              Text(target.display)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Color(hex: theme.faint))
                .lineLimit(1)
                .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(Color(hex: theme.faint))
          }
          .frame(minHeight: CwdSheetTuning.rowMinHeight)
          .contentShape(Rectangle())
        }
        .listRowBackground(cell(theme))
      } else if let error = lookup.error {
        notice(icon: "exclamationmark.triangle", tint: theme.destructive, title: error.title, message: error.message, action: nil, theme)
      }
    } else {
      HStack(spacing: 10) {
        ProgressView()
        Text(args.strings.checking)
          .font(.system(size: 15))
          .foregroundStyle(Color(hex: theme.muted))
      }
      .frame(minHeight: CwdSheetTuning.rowMinHeight)
      .listRowBackground(cell(theme))
    }
  }

  /// An empty folder, a search with no match, or a folder the relay couldn't
  /// read: centered, with "Try again" for the last.
  private func notice(
    icon: String?, tint: String, title: String, message: String, action: (label: String, run: () -> Void)?, _ theme: ShellTheme
  ) -> some View {
    VStack(spacing: 8) {
      if let icon {
        Image(systemName: icon)
          .font(.system(size: 30))
          .foregroundStyle(Color(hex: tint))
      }
      Text(title)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(Color(hex: theme.foreground))
        .multilineTextAlignment(.center)
      Text(message)
        .font(.system(size: 15))
        .foregroundStyle(Color(hex: theme.muted))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      if let action {
        Button(action: action.run) {
          Text(action.label)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Color(hex: theme.primary))
            .padding(.horizontal, 20)
            .frame(height: 44)
            .background(Capsule().fill(Color(hex: theme.primary).opacity(0.14)))
            .contentShape(Capsule())
        }
        // Only the button: the rest of the row isn't a tap target.
        .buttonStyle(.borderless)
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 20)
    .padding(.horizontal, 8)
    .listRowBackground(cell(theme))
  }

  // MARK: Footer

  /// The folder on screen and the button that picks it. It is this screen's
  /// own, so it slides with the screen on a push or a swipe back.
  private func footer(_ args: CwdPickerArgs) -> some View {
    let theme = args.theme
    let isCurrent = folder.path == args.current.path
    let canUse = !isCurrent && store.folder(folder.path)?.status == .ready
    return VStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 0) {
        Text(args.strings.selected)
          .font(.system(size: 12))
          .foregroundStyle(Color(hex: theme.faint))
        Text(folder.display)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(Color(hex: theme.muted))
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 8)
      Button {
        store.choose(folder.path)
      } label: {
        Text(isCurrent ? args.strings.alreadyCurrent : args.strings.useFolder)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(Color(hex: canUse ? theme.primaryForeground : theme.muted))
          .frame(maxWidth: .infinity)
          .frame(height: CwdSheetTuning.buttonHeight)
          .background(Capsule().fill(canUse ? Color(hex: theme.primary) : Color(hex: theme.foreground).opacity(0.1)))
          .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      .disabled(!canUse)
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }
}

/// Four placeholder rows while a folder is listed, pulsing.
private struct CwdSkeletonRows: View {
  let theme: ShellTheme
  let label: String
  @State private var dim = false

  var body: some View {
    ForEach(Array(CwdSheetTuning.skeletonWidths.enumerated()), id: \.offset) { _, share in
      HStack(spacing: 12) {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
          .frame(width: 22, height: 18)
          .frame(width: CwdSheetTuning.iconWidth)
        RoundedRectangle(cornerRadius: 5, style: .continuous)
          .frame(width: 200 * share, height: 12)
        Spacer(minLength: 0)
      }
      .foregroundStyle(Color(hex: theme.foreground).opacity(0.12))
      .frame(minHeight: CwdSheetTuning.rowMinHeight)
      .opacity(dim ? 0.45 : 1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .onAppear {
      withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { dim = true }
    }
  }
}

private extension View {
  /// The footer under the list. On iOS 26 it sits in a bar that softens the
  /// list scrolling under it, like the system's own toolbars; before it, on
  /// the bar material.
  @ViewBuilder
  func pinnedFooter<Footer: View>(@ViewBuilder _ footer: () -> Footer) -> some View {
    if #available(iOS 26, *) {
      safeAreaBar(edge: .bottom) { footer() }
    } else {
      safeAreaInset(edge: .bottom, spacing: 0) { footer().background(.bar) }
    }
  }
}
