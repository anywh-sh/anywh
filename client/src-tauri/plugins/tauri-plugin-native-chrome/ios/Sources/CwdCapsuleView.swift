import SwiftUI

/// Tunables for the working directory capsule, in one place for on-device tuning.
enum CwdCapsuleTuning {
  /// Gap between the capsule and the composer under it.
  static let gap: CGFloat = 8
  /// Room the capsule always leaves on its right before its name truncates.
  static let trailingRoom: CGFloat = 64
  static let height: CGFloat = 44
  /// How long the capsule's outline stays lit after a folder is picked.
  static let flashSeconds: Double = 0.9
}

/// The conversation's folder, above the composer, while it can still be
/// chosen: a glass capsule with a folder icon, the folder's name and an
/// up-down chevron. Tapping it opens the working directory sheet. It leaves
/// once the first message fixes the folder (the top bar menu shows it then).
/// Drawn by `ComposerView`, so it rides the keyboard with the composer and
/// counts in the room the composer reports to the web layout.
struct CwdCapsuleView: View {
  @ObservedObject var store: CwdPickerStore
  @State private var lit = false

  var body: some View {
    if let args = store.args ?? store.lastArgs {
      let theme = args.theme
      Button {
        store.requestOpen()
      } label: {
        HStack(spacing: 8) {
          Image(systemName: "folder")
            .font(.system(size: 16))
            .foregroundStyle(Color(hex: theme.muted))
          Text(args.capsule.name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Color(hex: theme.foreground))
            .lineLimit(1)
            .truncationMode(.middle)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Color(hex: theme.faint))
        }
        .padding(.horizontal, 14)
        .frame(height: CwdCapsuleTuning.height)
        .contentShape(Capsule())
        .glassBackground(Capsule(), tint: Color(hex: theme.tint))
        .overlay(Capsule().strokeBorder(Color(hex: theme.primary).opacity(lit ? 0.55 : 0), lineWidth: 1))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(args.capsule.accessibilityLabel)
      .onChange(of: args.flash) { old, new in
        guard new > old else { return }
        withAnimation(.easeOut(duration: 0.15)) { lit = true }
        withAnimation(.easeIn(duration: 0.3).delay(CwdCapsuleTuning.flashSeconds)) { lit = false }
      }
    }
  }
}
