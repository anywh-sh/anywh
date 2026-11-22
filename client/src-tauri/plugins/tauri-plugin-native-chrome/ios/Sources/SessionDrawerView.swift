import SwiftUI
import UIKit

/// Width of the drawer the canvas slides away from.
let drawerWidth: CGFloat = 268

struct SessionDrawerView: View {
  @ObservedObject var store: DrawerStore
  @State private var renaming: DrawerSession?
  @State private var renameText = ""
  @State private var deleting: DrawerSession?

  var body: some View {
    let args = store.args
    let theme = args?.theme ?? .fallback
    ZStack(alignment: .topLeading) {
      Color(hex: theme.sidebar).ignoresSafeArea()
      if let args {
        content(args, theme)
      }
    }
    .frame(width: drawerWidth)
    .alert(args?.strings.renameTitle ?? "", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("", text: $renameText)
      Button(args?.strings.cancel ?? "", role: .cancel) {}
      Button(args?.strings.save ?? "") {
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let session = renaming, !title.isEmpty { store.onRename(session, title) }
      }
    } message: {
      Text(args?.strings.renameDescription ?? "")
    }
    .alert(args?.strings.deleteTitle ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
      Button(args?.strings.cancel ?? "", role: .cancel) {}
      Button(args?.strings.delete ?? "", role: .destructive) {
        if let session = deleting { store.onDelete(session) }
      }
    } message: {
      Text((args?.strings.deleteBody ?? "").replacingOccurrences(of: "{title}", with: deleting?.title ?? ""))
    }
  }

  @ViewBuilder
  private func content(_ args: DrawerArgs, _ theme: ShellTheme) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      header(theme)
      if args.profiles.count > 1 { profilePicker(args, theme) }
      if let bots = args.bots {
        // Bots and Conversations take turns: the open one fills the drawer,
        // the other folds to its heading at the bottom.
        if bots.section == "bots" {
          sectionHeading(bots.botsLabel, open: true, bots: bots, theme: theme, showAdd: true)
          botList(bots, theme)
          Spacer(minLength: 0)
          sectionHeading(bots.conversationsLabel, open: false, bots: bots, theme: theme, showAdd: false)
        } else {
          sectionHeading(bots.conversationsLabel, open: true, bots: bots, theme: theme, showAdd: false)
          list(args, theme)
          Spacer(minLength: 0)
          sectionHeading(bots.botsLabel, open: false, bots: bots, theme: theme, showAdd: true)
        }
      } else {
        list(args, theme)
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  /// A section's heading. Tapping the folded one opens it (and folds the
  /// other); the folded Bots heading still says when a bot waits.
  private func sectionHeading(_ label: String, open: Bool, bots: DrawerBots, theme: ShellTheme, showAdd: Bool) -> some View {
    HStack(spacing: 8) {
      Button {
        if !open { store.onSection(bots.section == "bots" ? "conversations" : "bots") }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
          Text(label)
            .font(.system(size: 11, design: .monospaced))
            .tracking(1.2)
            .textCase(.uppercase)
          if !open && showAdd && !bots.waitingLabel.isEmpty {
            Circle().fill(Color(hex: theme.primary)).frame(width: 6, height: 6)
            Text(bots.waitingLabel).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Color(hex: theme.primary))
          }
          Spacer(minLength: 0)
        }
        .foregroundStyle(Color(hex: theme.faint))
        .padding(.vertical, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if showAdd {
        Button {
          store.onNewBot()
        } label: {
          Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(hex: theme.muted)).frame(width: 32, height: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(bots.newBotLabel)
      }
    }
    .padding(.horizontal, 4)
    .overlay(alignment: .top) {
      if !open { Rectangle().fill(Color(hex: theme.border)).frame(height: 1) }
    }
  }

  private func botList(_ bots: DrawerBots, _ theme: ShellTheme) -> some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if bots.items.isEmpty {
          VStack(spacing: 10) {
            Text(bots.emptyTitle).font(.system(size: 12, design: .monospaced)).foregroundStyle(Color(hex: theme.muted))
            Text(bots.emptyBody).font(.system(size: 12)).multilineTextAlignment(.center).foregroundStyle(Color(hex: theme.faint))
            Button(bots.newBotLabel) { store.onNewBot() }.buttonStyle(.bordered).controlSize(.small)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 36)
        }
        ForEach(bots.items) { bot in
          botRow(bot, theme)
        }
      }
    }
    .scrollIndicators(.hidden)
  }

  private func botRow(_ bot: DrawerBot, _ theme: ShellTheme) -> some View {
    Button {
      store.onSelectBot(bot)
    } label: {
      HStack(spacing: 12) {
        MascotView(pixels: bot.mascot, palette: bot.mascotPalette.map { Color(hex: $0) })
          .frame(width: 32, height: 32)
          .overlay(alignment: .bottomTrailing) { badge(bot.badge, theme) }
        VStack(alignment: .leading, spacing: 2) {
          Text(bot.name)
            .font(.system(size: 16, weight: bot.selected ? .semibold : .regular))
            .foregroundStyle(Color(hex: bot.selected ? theme.foreground : theme.muted))
            .lineLimit(1)
          Text(bot.line)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(Color(hex: bot.tone == "attention" ? theme.primary : bot.tone == "fail" ? theme.destructive : theme.faint))
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Rectangle().fill(bot.selected ? Color(hex: theme.elevated) : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func badge(_ kind: String?, _ theme: ShellTheme) -> some View {
    switch kind {
    case "needsYou": Circle().fill(Color(hex: theme.primary)).frame(width: 9, height: 9)
    case "failed": Rectangle().fill(Color(hex: theme.destructive)).frame(width: 8, height: 8)
    case "working": Circle().fill(Color(hex: theme.faint)).frame(width: 8, height: 8)
    case "paused": Rectangle().fill(Color(hex: theme.muted)).frame(width: 8, height: 8)
    case "limit": Image(systemName: "clock").font(.system(size: 8, weight: .semibold)).foregroundStyle(Color(hex: theme.destructive))
    default: EmptyView()
    }
  }

  private func header(_ theme: ShellTheme) -> some View {
    HStack(spacing: 10) {
      Text(">")
        .font(.system(size: 14, weight: .bold, design: .monospaced))
        .foregroundStyle(Color(hex: theme.background))
        .frame(width: 26, height: 26)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: theme.primary)))
      Text("anywh.sh")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(Color(hex: theme.foreground))
    }
    .padding(.horizontal, 2)
    .padding(.top, 6)
  }

  /// A dropdown of the profiles: the trigger shows the active one, the menu is
  /// the system's (Liquid Glass on iOS 26) with the active profile checked.
  private func profilePicker(_ args: DrawerArgs, _ theme: ShellTheme) -> some View {
    let active = args.profiles.first { $0.id == args.activeProfileId }
    return Menu {
      Picker(selection: Binding(get: { args.activeProfileId }, set: { store.onProfileChange($0) })) {
        ForEach(args.profiles) { profile in
          Text(profile.label).tag(profile.id)
        }
      } label: { EmptyView() }
    } label: {
      HStack(spacing: 8) {
        Circle().fill(Color(hex: active?.color ?? theme.muted)).frame(width: 8, height: 8)
        Text(active?.label ?? "")
          .font(.system(size: 14, weight: .semibold))
          .lineLimit(1)
        Spacer(minLength: 0)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold))
      }
      .foregroundStyle(Color(hex: theme.foreground))
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .contentShape(Capsule())
      .profilePillBackground(border: Color(hex: theme.tint))
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func list(_ args: DrawerArgs, _ theme: ShellTheme) -> some View {
    if args.loading {
      DrawerSkeleton(theme: theme)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if args.error {
            VStack(alignment: .leading, spacing: 8) {
              Text(args.strings.loadFailed).font(.system(size: 12)).foregroundStyle(Color(hex: theme.muted))
              Button(args.strings.retry) { store.onRetry() }.buttonStyle(.bordered).controlSize(.small)
            }
            .padding(8)
          } else if args.groups.isEmpty {
            emptyState(args, theme)
          }
          ForEach(args.groups) { group in
            Text(group.label)
              .font(.system(size: 10, design: .monospaced))
              .tracking(1.4)
              .textCase(.uppercase)
              .foregroundStyle(Color(hex: theme.faint))
              .padding(.horizontal, 4)
              .padding(.top, 16)
              .padding(.bottom, 6)
            ForEach(group.sessions) { session in
              row(session, args, theme)
            }
          }
          if args.hasMore && !args.error { allChatsButton(args, theme) }
        }
      }
      .scrollIndicators(.hidden)
      // Run under the home indicator area down to the screen edge; the margin
      // only shows once scrolled to the very end, so the last row is not
      // glued to the bottom.
      .contentMargins(.bottom, 32, for: .scrollContent)
      .ignoresSafeArea(.container, edges: .bottom)
    }
  }

  /// Shown after the latest sessions when there are more. No action yet.
  private func allChatsButton(_ args: DrawerArgs, _ theme: ShellTheme) -> some View {
    Button {
      store.onAllChats()
    } label: {
      HStack(spacing: 4) {
        Text(args.strings.allChats).font(.system(size: 14, weight: .medium))
        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
        Spacer(minLength: 0)
      }
      .foregroundStyle(Color(hex: theme.muted))
      .padding(.horizontal, 12)
      .padding(.vertical, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.top, 8)
  }

  private func emptyState(_ args: DrawerArgs, _ theme: ShellTheme) -> some View {
    VStack(spacing: 10) {
      Image(systemName: "bubble.left")
        .font(.system(size: 16))
        .foregroundStyle(Color(hex: theme.faint))
        .frame(width: 32, height: 32)
        .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Color(hex: theme.border), style: StrokeStyle(lineWidth: 1, dash: [3])))
      Text(args.strings.emptyTitle).font(.system(size: 12, design: .monospaced)).foregroundStyle(Color(hex: theme.muted))
      Text(args.strings.emptyBody).font(.system(size: 12)).multilineTextAlignment(.center).foregroundStyle(Color(hex: theme.faint))
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 36)
  }

  private func row(_ session: DrawerSession, _ args: DrawerArgs, _ theme: ShellTheme) -> some View {
    Button {
      store.onSelect(session)
    } label: {
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text(session.title)
            .font(.system(size: 16, weight: session.selected ? .semibold : .regular))
            .foregroundStyle(Color(hex: session.selected ? theme.foreground : theme.muted))
            .lineLimit(1)
          if !session.meta.isEmpty {
            Text(session.meta)
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundStyle(Color(hex: theme.faint))
              .lineLimit(1)
          }
        }
        Spacer(minLength: 0)
        if session.running {
          ProgressView()
            .controlSize(.mini)
            .tint(Color(hex: session.color))
            .accessibilityLabel(args.strings.agentWorking)
        } else if session.backgroundJob {
          PulsingIcon(systemName: "terminal", color: Color(hex: theme.muted))
            .accessibilityLabel(args.strings.backgroundJob)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        Rectangle().fill(session.selected ? Color(hex: session.color).opacity(0.18) : .clear)
      )
      .overlay(alignment: .leading) {
        Rectangle()
          .fill(Color(hex: session.color))
          .frame(width: session.selected ? 3 : 2)
          .opacity(session.selected ? 1 : 0.55)
      }
      .overlay(
        Rectangle().strokeBorder(session.selected ? Color(hex: session.color).opacity(0.45) : .clear, lineWidth: 1)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button {
        renameText = session.title
        renaming = session
      } label: {
        Label(args.strings.rename, systemImage: "pencil")
      }
      Button(role: .destructive) {
        deleting = session
      } label: {
        Label(args.strings.delete, systemImage: "trash")
      }
    }
  }
}

private struct PulsingIcon: View {
  let systemName: String
  let color: Color
  @State private var dimmed = false

  var body: some View {
    Image(systemName: systemName)
      .font(.system(size: 12))
      .foregroundStyle(color)
      .opacity(dimmed ? 0.35 : 1)
      .onAppear {
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dimmed = true }
      }
  }
}

private struct DrawerSkeleton: View {
  let theme: ShellTheme
  @State private var dimmed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(0..<7, id: \.self) { index in
        RoundedRectangle(cornerRadius: 6)
          .fill(Color(hex: theme.elevated))
          .frame(height: 38)
          .frame(maxWidth: index.isMultiple(of: 2) ? .infinity : 200, alignment: .leading)
      }
    }
    .padding(.top, 16)
    .opacity(dimmed ? 0.45 : 1)
    .onAppear {
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dimmed = true }
    }
  }
}

private extension View {
  /// Liquid Glass on iOS 26, a blurred material with a hairline before it.
  @ViewBuilder
  func profilePillBackground(border: Color) -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(.regular.interactive(), in: Capsule())
    } else {
      self
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(border.opacity(0.08), lineWidth: 1))
    }
  }
}

/// A bot's pixel face, drawn from the cells the web side computed: sixteen
/// rows of sixteen, each `.` (empty) or a letter naming a palette color,
/// square edges at every size.
struct MascotView: View {
  let pixels: String
  let palette: [Color]

  var body: some View {
    Canvas { context, size in
      let cells = Array(pixels.unicodeScalars)
      guard cells.count == 256 else { return }
      let cell = min(size.width, size.height) / 16
      for (index, scalar) in cells.enumerated() where scalar != "." {
        let colorIndex = Int(scalar.value) - 97
        guard colorIndex >= 0, colorIndex < palette.count else { continue }
        let rect = CGRect(x: CGFloat(index % 16) * cell, y: CGFloat(index / 16) * cell, width: cell, height: cell)
        context.fill(Path(rect), with: .color(palette[colorIndex]))
      }
    }
  }
}
