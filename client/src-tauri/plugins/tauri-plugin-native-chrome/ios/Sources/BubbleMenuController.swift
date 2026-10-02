import UIKit
import WebKit

struct BubbleRectArgs: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct BubbleItemArgs: Decodable {
  let id: String
  let label: String
  let systemIcon: String?
  let disabled: Bool?
  let disabledReason: String?
}

struct BubbleTargetArgs: Decodable {
  let id: String
  let rect: BubbleRectArgs?
  let items: [BubbleItemArgs]
}

struct BubbleSelectEvent: Encodable {
  let targetId: String
  let itemId: String
}

/// The system's own long-press menu for a chat bubble: the bubble lifts and
/// scales a little and the options appear around it, as in Messages. The
/// content is a web view, so the web side tells this controller which
/// rectangle is a bubble (on `touchstart`, well before the hold completes) and
/// what its menu holds; `UIContextMenuInteraction` then drives the gesture
/// itself and reports the pick back. A long-press anywhere else finds no
/// target and opens nothing.
@MainActor
final class BubbleMenuController: NSObject, UIContextMenuInteractionDelegate {
  private weak var webview: WKWebView?
  private var target: (id: String, rect: CGRect, items: [BubbleItemArgs])?

  /// Called with the target id and the picked item id.
  var onSelect: (String, String) -> Void = { _, _ in }

  func install(on webview: WKWebView) {
    self.webview = webview
    webview.addInteraction(UIContextMenuInteraction(delegate: self))
  }

  func setTarget(_ args: BubbleTargetArgs) {
    guard let rect = args.rect else {
      target = nil
      return
    }
    target = (args.id, CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height), args.items)
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let target, target.rect.contains(location) else { return nil }
    let targetId = target.id
    let items = target.items
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(
        children: items.map { item in
          let action = UIAction(
            title: item.label,
            image: item.systemIcon.flatMap { UIImage(systemName: $0) },
            attributes: item.disabled == true ? [.disabled] : [],
            handler: { _ in self?.onSelect(targetId, item.id) }
          )
          if let reason = item.disabledReason { action.subtitle = reason }
          return action
        })
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    preview()
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    preview()
  }

  /// The web view clipped to the bubble's rectangle: that is the piece that lifts.
  private func preview() -> UITargetedPreview? {
    guard let webview, let target else { return nil }
    let parameters = UIPreviewParameters()
    parameters.visiblePath = UIBezierPath(rect: target.rect)
    return UITargetedPreview(view: webview, parameters: parameters)
  }
}
