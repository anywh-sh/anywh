import CoreGraphics
import UIKit

/// The robot that stands for "agent": lucide's `bot`, the icon the web client
/// uses for the same thing. SF Symbols has no robot, so it is drawn here.
///
/// The drawing sits in `drawBot` and touches Core Graphics only, so it can be
/// rendered anywhere to look at the shape.
enum AgentIcon {
  /// A template image: the menu tints it like the SF Symbols beside it.
  static func bot(side: CGFloat = 18) -> UIImage {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
    let image = renderer.image { drawBot(in: $0.cgContext, side: side) }
    return image.withRenderingMode(.alwaysTemplate)
  }

  /// lucide `bot` (24x24 viewBox, 2pt round stroke), scaled to `side`.
  /// Expects a y-down context, which is what UIKit hands out.
  static func drawBot(in context: CGContext, side: CGFloat) {
    let scale = side / 24
    context.scaleBy(x: scale, y: scale)
    // Template images ignore the colour; only the alpha matters.
    context.setStrokeColor(CGColor(gray: 0, alpha: 1))
    context.setLineWidth(2)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    let path = CGMutablePath()
    // Antenna: M12 8V4H8
    path.move(to: CGPoint(x: 12, y: 8))
    path.addLine(to: CGPoint(x: 12, y: 4))
    path.addLine(to: CGPoint(x: 8, y: 4))
    // Head: rect x4 y8 w16 h12 rx2
    path.addPath(CGPath(roundedRect: CGRect(x: 4, y: 8, width: 16, height: 12), cornerWidth: 2, cornerHeight: 2, transform: nil))
    // Ears: M2 14h2 and M20 14h2
    path.move(to: CGPoint(x: 2, y: 14))
    path.addLine(to: CGPoint(x: 4, y: 14))
    path.move(to: CGPoint(x: 20, y: 14))
    path.addLine(to: CGPoint(x: 22, y: 14))
    // Eyes: M15 13v2 and M9 13v2
    path.move(to: CGPoint(x: 15, y: 13))
    path.addLine(to: CGPoint(x: 15, y: 15))
    path.move(to: CGPoint(x: 9, y: 13))
    path.addLine(to: CGPoint(x: 9, y: 15))

    context.addPath(path)
    context.strokePath()
  }
}
