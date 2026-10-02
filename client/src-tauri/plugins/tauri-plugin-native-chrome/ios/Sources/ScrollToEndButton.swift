import SwiftUI

let scrollToEndSize: CGFloat = 44

/// The round glass arrow that jumps back to the end of a conversation the user
/// scrolled away from. The web side decides when it is visible; this fades it
/// and reports the tap.
struct ScrollToEndButton: View {
  @ObservedObject var store: ComposerStore

  var body: some View {
    let args = store.args
    let visible = store.scrollToEndVisible && !(args?.hidden ?? true)
    let theme = args?.theme ?? ShellTheme.fallback
    Button {
      store.onScrollToEnd()
    } label: {
      Image(systemName: "arrow.down")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(Color(hex: theme.foreground))
        .frame(width: scrollToEndSize, height: scrollToEndSize)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .glassBackground(Circle(), tint: Color(hex: theme.tint))
    .opacity(visible ? 1 : 0)
    .allowsHitTesting(visible)
    .animation(.easeInOut(duration: 0.2), value: visible)
    .accessibilityLabel(args?.strings.scrollToEnd ?? "")
    .accessibilityHidden(!visible)
  }
}
