import SwiftUI
import UIKit

/// Height of the single-pill top bar, and the gap between it and the safe area.
let topBarHeight: CGFloat = 52
let topBarTopGap: CGFloat = 8
let topBarSideInset: CGFloat = 16

struct TopBarView: View {
  @ObservedObject var store: TopBarStore
  @State private var pulse = false

  var body: some View {
    if let args = store.args {
      let theme = args.theme
      HStack(spacing: 4) {
        iconButton("line.3.horizontal", label: args.openSidebarLabel, theme: theme) { store.onMenu() }
        VStack(spacing: 2) {
          Text(args.title)
            .font(.system(size: 14.5, weight: .semibold))
            .foregroundStyle(Color(hex: theme.foreground))
            .lineLimit(1)
            .frame(maxWidth: .infinity)
          if let model = args.modelLabel {
            HStack(spacing: 6) {
              Circle()
                .fill(Color(hex: args.connected ? theme.success : theme.destructive))
                .frame(width: 6, height: 6)
                .opacity(args.connected ? 1 : (pulse ? 0.3 : 1))
                .accessibilityLabel(args.connectionLabel)
              Text(model)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(Color(hex: args.connected ? theme.muted : theme.destructive))
                .lineLimit(1)
            }
          }
        }
        iconButton("plus", label: args.newConversationLabel, theme: theme) { store.onNewConversation() }
      }
      .padding(.horizontal, 6)
      .frame(height: topBarHeight)
      .pillBackground(tint: Color(hex: theme.tint))
      .onAppear {
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { pulse = true }
      }
    }
  }

  private func iconButton(_ systemName: String, label: String, theme: ShellTheme, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(.system(size: 17, weight: .regular))
        .foregroundStyle(Color(hex: theme.foreground))
        .frame(width: 40, height: 40)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

private extension View {
  /// Liquid Glass on iOS 26, a blurred material with a hairline before it.
  @ViewBuilder
  func pillBackground(tint: Color) -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(.regular, in: Capsule())
    } else {
      self
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.08), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
    }
  }
}

/// Blur strip under the status bar and the pill, fading out downward, so
/// messages scrolling beneath the bar blur and dissolve instead of cutting off.
final class TopEdgeBlurView: UIVisualEffectView {
  private let fade = CAGradientLayer()

  init() {
    super.init(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    isUserInteractionEnabled = false
    fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
    fade.locations = [0, 0.55, 1]
    fade.startPoint = CGPoint(x: 0.5, y: 0)
    fade.endPoint = CGPoint(x: 0.5, y: 1)
    layer.mask = fade
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    fade.frame = bounds
  }
}

/// Invisible view pinned to the canvas that reports when its safe area changes
/// (rotation, Dynamic Island, in-call bar), so the web layout can follow.
final class SafeAreaReporterView: UIView {
  var onChange: ((UIEdgeInsets) -> Void)?

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    onChange?(safeAreaInsets)
  }
}
