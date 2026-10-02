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

/// Progressive blur under the status bar and the pill: the blur radius is
/// strongest at the top edge and falls to nothing lower down, with no material
/// tint, so content scrolling underneath stays visible (blurred). A faint wash
/// of the theme's background color over the same area, fading the same way,
/// mutes what is underneath so it reads as receding. The fall-off lives only in
/// the filter's own radius mask: fading the view's opacity instead would
/// cross-fade sharp and blurred content into a ghosted, weakly blurred look.
final class TopEdgeBlurView: UIVisualEffectView {
  private var maskedHeight: CGFloat = 0
  private let wash = CAGradientLayer()

  /// Blur radius at the top edge, in points. Kept small on purpose: content
  /// under the bar should stay readable as softened text, not a smear.
  private static let maxRadius: CGFloat = 4
  /// Fall-off exponents (`alpha = (1 - t)^gamma`) of the blur radius mask, and
  /// the opacity of the theme-colored wash at the top edge.
  private static let blurGamma: CGFloat = 1.2
  private static let washOpacity: CGFloat = 0.3

  init() {
    super.init(effect: UIBlurEffect(style: .regular))
    isUserInteractionEnabled = false
    wash.startPoint = CGPoint(x: 0.5, y: 0)
    wash.endPoint = CGPoint(x: 0.5, y: 1)
    wash.zPosition = 10
    layer.addSublayer(wash)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// The theme background at a low opacity, fading toward the bottom.
  func setWash(_ color: UIColor) {
    let ramp = Self.ramp(gamma: 1)
    wash.colors = ramp.map { color.withAlphaComponent(Self.washOpacity * $0.alpha).cgColor }
    wash.locations = ramp.map { NSNumber(value: Double($0.t)) }
  }

  /// `alpha = (1 - t)^gamma` sampled along the strip (1 at the top, 0 at the bottom).
  private static func ramp(gamma: CGFloat, steps: Int = 48) -> [(t: CGFloat, alpha: CGFloat)] {
    (0...steps).map { i in
      let t = CGFloat(i) / CGFloat(steps)
      return (t, pow(1 - t, gamma))
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    wash.frame = bounds
    guard bounds.height > 0, bounds.height != maskedHeight else { return }
    maskedHeight = bounds.height
    applyVariableBlur()
  }

  private func applyVariableBlur() {
    guard
      let filterClass = NSClassFromString("CAFilter") as? NSObject.Type,
      let filter = filterClass.perform(NSSelectorFromString("filterWithType:"), with: "variableBlur")?
        .takeUnretainedValue() as? NSObject,
      let backdrop = subviews.first(where: { String(describing: type(of: $0)).contains("Backdrop") })
    else {
      NSLog("[native-chrome] variable blur unavailable; falling back to the plain material")
      return
    }
    filter.setValue(Self.maxRadius, forKey: "inputRadius")
    filter.setValue(maskImage(height: bounds.height), forKey: "inputMaskImage")
    filter.setValue(true, forKey: "inputNormalizeEdges")
    backdrop.layer.filters = [filter]
    // Everything but the backdrop is the material's tint/vibrancy; drop it.
    for view in subviews where view !== backdrop { view.alpha = 0 }
  }

  /// Opaque at the top, transparent at the bottom: the filter reads this as
  /// "how much of the radius applies here".
  private func maskImage(height: CGFloat) -> CGImage? {
    let size = CGSize(width: 1, height: max(height, 1))
    let renderer = UIGraphicsImageRenderer(size: size)
    let image = renderer.image { context in
      let ramp = Self.ramp(gamma: Self.blurGamma)
      guard let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: ramp.map { UIColor.black.withAlphaComponent($0.alpha).cgColor } as CFArray,
        locations: ramp.map { $0.t }
      ) else { return }
      context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
    }
    return image.cgImage
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
