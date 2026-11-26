import SwiftUI
import UIKit

/// Opens and closes the question sheet (`ChoiceSheetView`). It is presented
/// from Tauri's view controller, like the attachment pickers: the shell's own
/// hosting views are not its children, so a SwiftUI `.sheet` from inside them
/// has nothing to present from.
///
/// The sheet starts at a height fitted to the question (measured by the view)
/// and can be pulled up to full height; focusing the free-text field takes it
/// there, so the keyboard never covers the field. Closing it (pulled down or
/// the close button) only closes it: the question stays pending in the
/// composer's row. It also closes when the question goes away, answered here
/// or anywhere else.
@MainActor
final class ChoiceSheetController: NSObject, UISheetPresentationControllerDelegate {
  private static let fittedId = UISheetPresentationController.Detent.Identifier("sh.anywh.choice.fitted")

  private let store: ChoiceStore
  private let presenter: () -> UIViewController?
  private var host: UIHostingController<ChoiceSheetView>?
  /// Lays the sheet's content out off screen to work out its height before
  /// it opens.
  private lazy var sizer = UIHostingController(rootView: ChoiceSheetView(store: store, fitting: true))

  /// Runs right before the sheet opens: the composer drops its keyboard.
  var willPresent: () -> Void = {}
  /// Hides the composer while the sheet is over it (`true`), and brings it
  /// back as the sheet leaves (`false`).
  var coverComposer: (Bool) -> Void = { _ in }

  init(store: ChoiceStore, presenter: @escaping () -> UIViewController?) {
    self.store = store
    self.presenter = presenter
    super.init()
    store.onOpen = { [weak self] in self?.present() }
    store.onClose = { [weak self] in self?.dismiss() }
    store.onFieldFocus = { [weak self] in self?.expand() }
    store.onMeasure = { [weak self] in self?.refit() }
  }

  /// A new payload: `nil` closes the sheet.
  func apply(_ args: ChoiceSheetArgs?) {
    store.apply(args)
    guard let args else {
      dismiss()
      return
    }
    applyTheme(args.theme)
  }

  // MARK: Presentation

  private func present() {
    guard host == nil, store.args != nil, let presenter = presenter() else { return }
    // Something else is up already (a picker, a menu): leave it alone.
    guard presenter.presentedViewController == nil else { return }
    willPresent()
    coverComposer(true)
    // Without this the first resolution of the fitted detent had nothing
    // measured (the sheet opened at full height) or the last question's
    // measurements (it opened at that height), and then jumped once the
    // sheet laid itself out.
    let fit = CGSize(width: presenter.view.bounds.width, height: .greatestFiniteMagnitude)
    store.resetMeasurements(estimate: sizer.sizeThatFits(in: fit).height)

    let host = UIHostingController(rootView: ChoiceSheetView(store: store))
    host.modalPresentationStyle = .pageSheet
    if let sheet = host.sheetPresentationController {
      let store = self.store
      let fitted = UISheetPresentationController.Detent.custom(identifier: Self.fittedId) { context in
        MainActor.assumeIsolated {
          // Not measured yet, or as tall as the screen allows: no fitted
          // height, the sheet opens at full height.
          let height = store.fittedHeight
          return height > 0 && height < context.maximumDetentValue ? height : nil
        }
      }
      sheet.detents = [fitted, .large()]
      sheet.selectedDetentIdentifier = Self.fittedId
      sheet.prefersGrabberVisible = true
      sheet.prefersScrollingExpandsWhenScrolledToEdge = true
      sheet.delegate = self
    }
    self.host = host
    if let theme = store.args?.theme { applyTheme(theme) }
    presenter.present(host, animated: true)
  }

  private func dismiss() {
    guard let host else { return }
    self.host = nil
    coverComposer(false)
    host.dismiss(animated: true)
  }

  /// The user started pulling the sheet down: the composer comes back under
  /// it right away, and steps aside again if the sheet springs back up.
  func presentationControllerWillDismiss(_ presentationController: UIPresentationController) {
    uncoverWhilePulledDown(presentationController) { [weak self] covered in self?.coverComposer(covered) }
  }

  /// Pulled down by the user: the question stays pending.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    host = nil
    coverComposer(false)
  }

  // MARK: Height

  private func expand() {
    guard let sheet = host?.sheetPresentationController, sheet.selectedDetentIdentifier != .large else { return }
    sheet.animateChanges { sheet.selectedDetentIdentifier = .large }
  }

  /// The question changed size (another step, a status line): the fitted
  /// detent follows.
  private func refit() {
    guard let sheet = host?.sheetPresentationController else { return }
    sheet.animateChanges { sheet.invalidateDetents() }
  }

  // MARK: Theme

  private func applyTheme(_ theme: ShellTheme) {
    guard let host else { return }
    styleSheet(host, theme: theme)
  }
}
