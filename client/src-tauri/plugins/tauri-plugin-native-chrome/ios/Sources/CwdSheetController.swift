import SwiftUI
import UIKit

/// Opens and closes the working directory sheet (`CwdSheetView`), presented
/// from Tauri's view controller like the question sheet. It opens at a middle
/// height and can be pulled to full height; focusing the search field takes
/// it there. It closes when the user pulls it down or taps close, after a
/// pick, and when the picker goes away (the folder was fixed) or turns out to
/// be another conversation's.
@MainActor
final class CwdSheetController: NSObject, UISheetPresentationControllerDelegate {
  private static let mediumId = UISheetPresentationController.Detent.Identifier("sh.anywh.cwd.medium")
  /// The middle height: this share of full height, at most `mediumMax`.
  private static let mediumShare: CGFloat = 0.72
  private static let mediumMax: CGFloat = 548

  private let store: CwdPickerStore
  private let presenter: () -> UIViewController?
  private var host: UIHostingController<CwdSheetView>?

  /// Runs right before the sheet opens: the composer drops its keyboard.
  var willPresent: () -> Void = {}
  /// Hides the composer while the sheet is over it (`true`), and brings it
  /// back as the sheet leaves (`false`).
  var coverComposer: (Bool) -> Void = { _ in }

  init(store: CwdPickerStore, presenter: @escaping () -> UIViewController?) {
    self.store = store
    self.presenter = presenter
    super.init()
    store.onPresent = { [weak self] in self?.present() }
    store.onDismiss = { [weak self] in self?.dismiss() }
    store.onSearchFocus = { [weak self] in self?.expand() }
  }

  /// A new payload: `nil`, or another conversation's, closes an open sheet.
  func apply(_ args: CwdPickerArgs?) {
    if store.apply(args) { dismiss() }
    if let host, let args { styleSheet(host, theme: args.theme) }
  }

  // MARK: Presentation

  private func present() {
    guard host == nil, let theme = store.args?.theme, let presenter = presenter() else { return }
    // Something else is up already (a picker, the question sheet): leave it.
    guard presenter.presentedViewController == nil else { return }
    willPresent()
    coverComposer(true)
    store.begin()

    let host = UIHostingController(rootView: CwdSheetView(store: store))
    host.modalPresentationStyle = .pageSheet
    if let sheet = host.sheetPresentationController {
      let medium = UISheetPresentationController.Detent.custom(identifier: Self.mediumId) { context in
        min(Self.mediumMax, context.maximumDetentValue * Self.mediumShare)
      }
      sheet.detents = [medium, .large()]
      sheet.selectedDetentIdentifier = Self.mediumId
      sheet.prefersGrabberVisible = true
      sheet.prefersScrollingExpandsWhenScrolledToEdge = true
      sheet.delegate = self
    }
    self.host = host
    styleSheet(host, theme: theme)
    presenter.present(host, animated: true)
  }

  private func dismiss() {
    guard let host else { return }
    self.host = nil
    coverComposer(false)
    store.end()
    host.dismiss(animated: true)
  }

  /// The user started pulling the sheet down: the composer comes back under
  /// it right away, and steps aside again if the sheet springs back up.
  func presentationControllerWillDismiss(_ presentationController: UIPresentationController) {
    uncoverWhilePulledDown(presentationController) { [weak self] covered in self?.coverComposer(covered) }
  }

  /// Pulled down by the user: nothing was picked.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    host = nil
    coverComposer(false)
    store.end()
  }

  // MARK: Height

  private func expand() {
    guard let sheet = host?.sheetPresentationController, sheet.selectedDetentIdentifier != .large else { return }
    sheet.animateChanges { sheet.selectedDetentIdentifier = .large }
  }
}
