import UIKit

/// The strip at the bottom of the screen: the theme's background at a low
/// opacity from the base up to the composer, then a short fade to nothing, so
/// text scrolling under the composer reads as receding with no hard line. The
/// same idea as the top bar's wash, without the blur — the composer's own glass
/// already blurs what is behind it.
final class BottomEdgeWashView: UIView {
  private let gradient = CAGradientLayer()
  private var color = UIColor.clear

  /// Where the solid part starts, measured from the top of this view.
  var fadeHeight: CGFloat = 16 {
    didSet { setNeedsLayout() }
  }
  var opacity: CGFloat = 0.35 {
    didSet { applyColors() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    gradient.startPoint = CGPoint(x: 0.5, y: 0)
    gradient.endPoint = CGPoint(x: 0.5, y: 1)
    layer.addSublayer(gradient)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func setColor(_ value: UIColor) {
    color = value
    applyColors()
  }

  private func applyColors() {
    gradient.colors = [
      color.withAlphaComponent(0).cgColor,
      color.withAlphaComponent(opacity).cgColor,
      color.withAlphaComponent(opacity).cgColor,
    ]
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = bounds
    let fraction = bounds.height > 0 ? min(fadeHeight / bounds.height, 1) : 0
    gradient.locations = [0, NSNumber(value: Double(fraction)), 1]
    CATransaction.commit()
  }
}
