import SwiftUI
import UIKit
import WebKit

/// Tunables for the composer and its surroundings, in one place for on-device tuning.
private enum Tuning {
  /// Opacity of the theme background strip behind the composer.
  static let bottomWashOpacity: CGFloat = 0.65
  /// Height of the fade above the composer, from the strip's opacity to nothing.
  static let bottomWashFade: CGFloat = 16
  /// Gap between the composer and the keyboard / the bottom safe area.
  static let bottomGap: CGFloat = 2
  /// Gap between the scroll-to-end arrow and whatever sits above the strip.
  static let arrowGap: CGFloat = 4
  /// Room kept above the text field for the top bar, banners, chips and padding.
  static let reservedAbove: CGFloat = 140
  static let minFieldHeight: CGFloat = 88
  static let maxFieldHeight: CGFloat = 200
}

/// A plain view that reports when it was laid out, so the controller can
/// follow the composer's size and the keyboard.
private final class ComposerContainerView: UIView {
  var onLayout: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}

/// The native composer, the strip under it and the scroll-to-end arrow, laid
/// over the web canvas. It owns geometry only: the composer follows the
/// keyboard through `keyboardLayoutGuide`, and the web layout is told how much
/// room the whole thing takes (`--native-bottom-inset`) so it can pad the log
/// and float its own controls above. Every decision stays on the web side.
@MainActor
final class ComposerController {
  let store: ComposerStore

  private weak var canvas: UIView?
  private weak var webview: WKWebView?
  private let container = ComposerContainerView()
  private let host: UIHostingController<ComposerView>
  private let arrowHost: UIHostingController<ScrollToEndButton>
  private let wash = BottomEdgeWashView()
  private let picker = AttachmentPicker()
  private let presenter: () -> UIViewController?
  private var arrowBottom: NSLayoutConstraint?
  private var lastInset: Int?

  /// Fires with the files chosen in the Photos / Files pickers.
  var onAttach: ([AttachedFile]) -> Void = { _ in }

  init(store: ComposerStore, presenter: @escaping () -> UIViewController?) {
    self.store = store
    self.presenter = presenter
    self.host = UIHostingController(rootView: ComposerView(store: store))
    self.arrowHost = UIHostingController(rootView: ScrollToEndButton(store: store))
    store.onAttachPhotos = { [weak self] in self?.presentPicker(photos: true) }
    store.onAttachFiles = { [weak self] in self?.presentPicker(photos: false) }
    picker.onFiles = { [weak self] files in self?.onAttach(files) }
  }

  // MARK: Install

  // Like the drawer's, the hosting controllers are retained here and not added
  // as children of Tauri's view controller.
  func install(in canvas: UIView, below dim: UIView, webview: WKWebView?) {
    self.canvas = canvas
    self.webview = webview
    AttachmentFiles.purge()

    wash.fadeHeight = Tuning.bottomWashFade
    wash.opacity = Tuning.bottomWashOpacity
    wash.alpha = 0
    wash.translatesAutoresizingMaskIntoConstraints = false
    canvas.insertSubview(wash, belowSubview: dim)

    let arrow = arrowHost.view!
    arrow.backgroundColor = .clear
    arrow.translatesAutoresizingMaskIntoConstraints = false
    arrow.isUserInteractionEnabled = false
    canvas.insertSubview(arrow, belowSubview: dim)

    container.alpha = 0
    container.isUserInteractionEnabled = false
    container.translatesAutoresizingMaskIntoConstraints = false
    container.onLayout = { [weak self] in self?.layoutDidChange() }
    canvas.insertSubview(container, belowSubview: dim)

    host.sizingOptions = [.intrinsicContentSize]
    let content = host.view!
    content.backgroundColor = .clear
    content.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(content)

    canvas.keyboardLayoutGuide.followsUndockedKeyboard = false
    let keyboardTop = canvas.keyboardLayoutGuide.topAnchor
    let safeBottom = canvas.safeAreaLayoutGuide.bottomAnchor
    // Rest on the keyboard (or the safe area when it is closed), never below
    // either: two hard ceilings and a softer pull toward the keyboard.
    let rest = container.bottomAnchor.constraint(equalTo: keyboardTop, constant: -Tuning.bottomGap)
    rest.priority = .defaultHigh
    let arrowBottom = arrow.bottomAnchor.constraint(
      equalTo: container.topAnchor, constant: -(Tuning.bottomWashFade + Tuning.arrowGap))
    self.arrowBottom = arrowBottom

    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      content.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      content.topAnchor.constraint(equalTo: container.topAnchor),
      content.bottomAnchor.constraint(equalTo: container.bottomAnchor),

      container.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: topBarSideInset),
      container.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -topBarSideInset),
      container.bottomAnchor.constraint(lessThanOrEqualTo: keyboardTop, constant: -Tuning.bottomGap),
      container.bottomAnchor.constraint(lessThanOrEqualTo: safeBottom, constant: -Tuning.bottomGap),
      rest,

      wash.leadingAnchor.constraint(equalTo: canvas.leadingAnchor),
      wash.trailingAnchor.constraint(equalTo: canvas.trailingAnchor),
      wash.bottomAnchor.constraint(equalTo: canvas.bottomAnchor),
      wash.topAnchor.constraint(equalTo: container.topAnchor, constant: -Tuning.bottomWashFade),

      arrow.centerXAnchor.constraint(equalTo: canvas.centerXAnchor),
      arrow.widthAnchor.constraint(equalToConstant: scrollToEndSize),
      arrow.heightAnchor.constraint(equalToConstant: scrollToEndSize),
      arrowBottom,
    ])
  }

  // MARK: State from the web side

  func apply(_ args: ComposerArgs) {
    let hidden = args.hidden
    applyTheme(args.theme)
    UIView.animate(withDuration: 0.15) {
      self.container.alpha = hidden ? 0 : 1
      self.wash.alpha = hidden ? 0 : 1
    }
    container.isUserInteractionEnabled = !hidden
    refreshArrowInteraction()
    if hidden { store.textView?.resignFirstResponder() }
    // The page may have reloaded since the inset was last injected.
    reportInset(force: true)
  }

  func applyTheme(_ theme: ShellTheme) {
    wash.setColor(UIColor(hex: theme.background))
    let style: UIUserInterfaceStyle = UIColor(hex: theme.background).isDark ? .dark : .light
    for view in [container, arrowHost.view!, wash] as [UIView] { view.overrideUserInterfaceStyle = style }
  }

  func setText(_ text: String) {
    if let view = store.textView {
      view.setText(text)
    } else {
      store.pendingText = text
    }
  }

  func focus() {
    if let view = store.textView {
      view.becomeFirstResponder()
    } else {
      store.pendingFocus = true
    }
  }

  func blur() {
    store.pendingFocus = false
    store.textView?.resignFirstResponder()
  }

  /// Closes the keyboard, e.g. when the drawer starts opening.
  func resign() {
    blur()
  }

  func setElapsed(_ label: String?) {
    store.elapsed = label
  }

  func setScrollToEnd(visible: Bool, accessoryHeight: CGFloat) {
    store.scrollToEndVisible = visible
    arrowBottom?.constant = -(Tuning.bottomWashFade + accessoryHeight + Tuning.arrowGap)
    refreshArrowInteraction()
  }

  private func refreshArrowInteraction() {
    let hidden = store.args?.hidden ?? true
    arrowHost.view.isUserInteractionEnabled = store.scrollToEndVisible && !hidden
  }

  /// Whether `view` is part of the composer or the arrow, so the drawer's pan
  /// can stand down: dragging the cursor or a selection in the field must not
  /// open the drawer.
  func owns(_ view: UIView?) -> Bool {
    guard let view else { return false }
    return view.isDescendant(of: container) || view.isDescendant(of: arrowHost.view)
  }

  // MARK: Layout

  private func layoutDidChange() {
    guard let canvas else { return }
    let keyboardTop = canvas.keyboardLayoutGuide.layoutFrame.minY
    let above = keyboardTop - canvas.safeAreaInsets.top - topBarTopGap - topBarHeight - Tuning.reservedAbove
    let limit = min(Tuning.maxFieldHeight, max(Tuning.minFieldHeight, above))
    if abs(store.maxFieldHeight - limit) > 0.5 { store.maxFieldHeight = limit }
    reportInset()
  }

  /// Tells the web layout how much room the composer's strip takes at the
  /// bottom: from the base of the canvas to the top of the strip's fade, so
  /// the keyboard is already counted when it is open. Cleared while hidden,
  /// which sends the web layout back to its fallback padding.
  func reportInset(force: Bool = false) {
    guard let canvas, container.bounds.height > 0 else { return }
    let hidden = store.args?.hidden ?? true
    let value: Int? = hidden ? nil : Int((canvas.bounds.height - container.frame.minY + Tuning.bottomWashFade).rounded())
    if !force && value == lastInset { return }
    lastInset = value
    let script =
      value.map { "document.documentElement.style.setProperty('--native-bottom-inset','\($0)px')" }
      ?? "document.documentElement.style.removeProperty('--native-bottom-inset')"
    webview?.evaluateJavaScript(script, completionHandler: nil)
  }

  // MARK: Pickers

  private func presentPicker(photos: Bool) {
    guard let presenter = presenter() else { return }
    if photos {
      picker.presentPhotos(from: presenter)
    } else {
      picker.presentFiles(from: presenter)
    }
  }
}
