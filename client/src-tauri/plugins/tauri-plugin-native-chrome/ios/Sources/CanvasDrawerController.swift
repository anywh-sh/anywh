import QuartzCore
import SwiftUI
import UIKit
import WebKit

/// Tunables for the drawer's look and feel, in one place for on-device tuning.
private enum Tuning {
  static let dimMax: CGFloat = 0.45
  static let hairlineMax: CGFloat = 0.16
  static let drawerAlphaMin: CGFloat = 0.6
  static let drawerScaleMin: CGFloat = 0.96
  static let shadowOpacity: Float = 0.35
  static let shadowRadius: CGFloat = 30
  /// How far ahead (seconds) a release velocity projects the resting point.
  static let projection: CGFloat = 0.2
  /// Spring angular frequency (rad/s) and damping ratio of the settle.
  static let springOmega: CGFloat = 22
  static let springDamping: CGFloat = 0.9
  static let fallbackCornerRadius: CGFloat = 44
  static let blurExtra: CGFloat = 0
}

/// Turns the app window into a drawer shell: the web canvas (the Tauri view
/// holding the `WKWebView`) slides right under a native pan to reveal a
/// SwiftUI conversation list behind it, with the native top bar and a top
/// blur strip layered over the web content. It owns geometry and gestures
/// only — every decision is made by the web side, which hears about it
/// through the store callbacks.
@MainActor
final class CanvasDrawerController: NSObject, UIGestureRecognizerDelegate {
  private let window: UIWindow
  private weak var webview: WKWebView?
  private let canvas: UIView
  private let shadow = UIView()
  private let dim = UIView()
  private let blocker = UIView()
  private let blur = TopEdgeBlurView()
  private let reporter = SafeAreaReporterView()
  private let drawerHost: UIHostingController<SessionDrawerView>
  private let topBarHost: UIHostingController<TopBarView>
  /// Two distinct taps, fired the moment the finger lets go (or a tap/button
  /// decides), not when the spring lands: one for opening, another for closing.
  /// Closing by picking a conversation therefore feels the same as dragging shut.
  private let openHaptic = UIImpactFeedbackGenerator(style: .medium)
  private let closeHaptic = UIImpactFeedbackGenerator(style: .rigid)
  /// The state the drawer last settled toward, so a release that falls back to
  /// where it started does not tap.
  private var targetOpen = false

  private var progress: CGFloat = 0
  private var panStartProgress: CGFloat = 0
  private var displayLink: CADisplayLink?
  private var spring: (target: CGFloat, velocity: CGFloat)?
  private var tint = UIColor.white

  /// Set by `set_gesture_hint`: the touch began inside a sideways scroller.
  var gestureBlocked = false
  var isOpen: Bool { progress > 0.5 }

  init?(webview: WKWebView, topBar: TopBarStore, drawer: DrawerStore) {
    guard let window = webview.window else { return nil }
    // The canvas is whatever sits directly under the window on the way up
    // from the webview; it is moved as one piece, never reparented.
    var top: UIView = webview
    while let next = top.superview, next !== window { top = next }
    NSLog("[native-chrome] canvas hierarchy: webview=\(type(of: webview)) canvas=\(type(of: top)) window=\(type(of: window))")

    self.window = window
    self.webview = webview
    self.canvas = top
    self.drawerHost = UIHostingController(rootView: SessionDrawerView(store: drawer))
    self.topBarHost = UIHostingController(rootView: TopBarView(store: topBar))
    super.init()

    installDrawer()
    installCanvasLayers()
    installGestures()
    applyCorners()
    apply(progress: 0)
  }

  // MARK: Setup

  // The hosting controllers are deliberately not added as children of Tauri's
  // view controller: their views live in the window and in the transition
  // view above that controller's own view, and UIKit raises when a child's
  // view sits outside its parent's. They stay retained here instead.
  private func installDrawer() {
    drawerHost.view.backgroundColor = .clear
    drawerHost.view.frame = CGRect(x: 0, y: 0, width: drawerWidth, height: window.bounds.height)
    drawerHost.view.autoresizingMask = [.flexibleHeight, .flexibleRightMargin]
    window.insertSubview(drawerHost.view, at: 0)

    shadow.isUserInteractionEnabled = false
    // Opaque so the layer casts a shadow in its own (rounded) shape; the
    // canvas covers it completely.
    shadow.backgroundColor = .black
    shadow.frame = canvas.frame
    shadow.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    shadow.layer.shadowColor = UIColor.black.cgColor
    shadow.layer.shadowOpacity = Tuning.shadowOpacity
    shadow.layer.shadowRadius = Tuning.shadowRadius
    shadow.layer.shadowOffset = .zero
    window.insertSubview(shadow, belowSubview: canvas)
  }

  private func installCanvasLayers() {
    func pin(_ view: UIView) {
      view.translatesAutoresizingMaskIntoConstraints = false
      canvas.addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: canvas.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: canvas.trailingAnchor),
        view.topAnchor.constraint(equalTo: canvas.topAnchor),
        view.bottomAnchor.constraint(equalTo: canvas.bottomAnchor),
      ])
    }

    reporter.isUserInteractionEnabled = false
    reporter.onChange = { [weak self] _ in self?.reportTopInset() }
    pin(reporter)

    blur.translatesAutoresizingMaskIntoConstraints = false
    canvas.addSubview(blur)
    NSLayoutConstraint.activate([
      blur.leadingAnchor.constraint(equalTo: canvas.leadingAnchor),
      blur.trailingAnchor.constraint(equalTo: canvas.trailingAnchor),
      blur.topAnchor.constraint(equalTo: canvas.topAnchor),
      blur.bottomAnchor.constraint(
        equalTo: canvas.safeAreaLayoutGuide.topAnchor,
        constant: topBarTopGap + topBarHeight + Tuning.blurExtra),
    ])

    let bar = topBarHost.view!
    bar.backgroundColor = .clear
    bar.translatesAutoresizingMaskIntoConstraints = false
    canvas.addSubview(bar)
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: topBarSideInset),
      bar.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -topBarSideInset),
      bar.topAnchor.constraint(equalTo: canvas.safeAreaLayoutGuide.topAnchor, constant: topBarTopGap),
      bar.heightAnchor.constraint(equalToConstant: topBarHeight),
    ])

    dim.isUserInteractionEnabled = false
    pin(dim)

    blocker.backgroundColor = .clear
    pin(blocker)
    blocker.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleBlockerTap)))
  }

  private func installGestures() {
    let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
    pan.delegate = self
    pan.cancelsTouchesInView = true
    canvas.addGestureRecognizer(pan)
  }

  /// In rest the canvas corners coincide with the screen's own, so they are
  /// invisible; once it slides they are what reads as a card.
  private func applyCorners() {
    if #available(iOS 26, *) {
      canvas.cornerConfiguration = .corners(radius: .containerConcentric())
      shadow.cornerConfiguration = .corners(radius: .containerConcentric())
    } else {
      let radius = (UIScreen.main.value(forKey: "_displayCornerRadius") as? CGFloat) ?? Tuning.fallbackCornerRadius
      for view in [canvas, shadow] {
        view.layer.cornerRadius = radius
        view.layer.cornerCurve = .continuous
      }
    }
    canvas.clipsToBounds = true
  }

  // MARK: Theme and layout

  func applyTheme(_ theme: ShellTheme) {
    let sidebar = UIColor(hex: theme.sidebar)
    window.backgroundColor = sidebar
    drawerHost.view.backgroundColor = sidebar
    dim.backgroundColor = UIColor(hex: theme.background)
    tint = UIColor(hex: theme.tint)
    // System materials follow the trait collection, so match it to the theme.
    let style: UIUserInterfaceStyle = UIColor(hex: theme.background).isDark ? .dark : .light
    blur.setWash(UIColor(hex: theme.background))
    blur.overrideUserInterfaceStyle = style
    topBarHost.view.overrideUserInterfaceStyle = style
    apply(progress: progress)
  }

  /// Tells the web layout how much room the native bar takes at the top.
  func reportTopInset() {
    let inset = Int((canvas.safeAreaInsets.top + topBarTopGap + topBarHeight + 4).rounded())
    webview?.evaluateJavaScript("document.documentElement.style.setProperty('--native-top-inset','\(inset)px')", completionHandler: nil)
  }

  // MARK: Progress

  private func apply(progress value: CGFloat) {
    progress = min(max(value, 0), 1)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let transform = CGAffineTransform(translationX: progress * drawerWidth, y: 0)
    canvas.transform = transform
    shadow.transform = transform
    shadow.alpha = progress
    dim.alpha = progress * Tuning.dimMax
    canvas.layer.borderWidth = progress > 0 ? 1 / UIScreen.main.scale : 0
    canvas.layer.borderColor = tint.withAlphaComponent(Tuning.hairlineMax * progress).cgColor
    let scale = Tuning.drawerScaleMin + (1 - Tuning.drawerScaleMin) * progress
    drawerHost.view.alpha = Tuning.drawerAlphaMin + (1 - Tuning.drawerAlphaMin) * progress
    drawerHost.view.transform = CGAffineTransform(scaleX: scale, y: scale)
    let open = progress > 0
    blocker.isHidden = !open
    webview?.accessibilityElementsHidden = open
    CATransaction.commit()
  }

  // MARK: Gestures

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
    let velocity = pan.velocity(in: canvas)
    if progress > 0.01 { return abs(velocity.x) > abs(velocity.y) }
    return velocity.x > 0 && abs(velocity.x) > 2 * abs(velocity.y) && !gestureBlocked
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }

  @objc private func handlePan(_ pan: UIPanGestureRecognizer) {
    switch pan.state {
    case .began:
      stopSpring()
      panStartProgress = progress
      openHaptic.prepare()
      closeHaptic.prepare()
      if progress == 0 {
        // Opening: dismiss the keyboard so it does not stay over the drawer.
        webview?.evaluateJavaScript("document.activeElement && document.activeElement.blur()", completionHandler: nil)
      }
    case .changed:
      apply(progress: panStartProgress + pan.translation(in: canvas).x / drawerWidth)
    case .ended, .cancelled, .failed:
      let velocity = pan.velocity(in: canvas).x
      let projected = progress * drawerWidth + velocity * Tuning.projection
      setOpen(projected > drawerWidth / 2, velocity: velocity)
    default:
      break
    }
  }

  @objc private func handleBlockerTap() {
    setOpen(false)
  }

  // MARK: Open / close

  func toggle() {
    setOpen(!isOpen)
  }

  /// Settles on the open or closed position with a spring, seeded with the
  /// release velocity (points/second). Taps the open or close haptic right
  /// away when this changes the state.
  func setOpen(_ open: Bool, velocity: CGFloat = 0) {
    if open != targetOpen {
      targetOpen = open
      (open ? openHaptic : closeHaptic).impactOccurred()
    }
    spring = (target: open ? 1 : 0, velocity: velocity / drawerWidth)
    guard displayLink == nil else { return }
    let link = CADisplayLink(target: self, selector: #selector(step(_:)))
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  private func stopSpring() {
    displayLink?.invalidate()
    displayLink = nil
    spring = nil
  }

  @objc private func step(_ link: CADisplayLink) {
    guard var state = spring else { return stopSpring() }
    let dt = CGFloat(min(link.targetTimestamp - link.timestamp, 1.0 / 30))
    let omega = Tuning.springOmega
    let damping = 2 * Tuning.springDamping * omega
    let acceleration = -omega * omega * (progress - state.target) - damping * state.velocity
    state.velocity += acceleration * dt
    spring = state
    let next = progress + state.velocity * dt
    if abs(next - state.target) < 0.0015 && abs(state.velocity) < 0.02 {
      stopSpring()
      apply(progress: state.target)
    } else {
      apply(progress: next)
    }
  }
}
