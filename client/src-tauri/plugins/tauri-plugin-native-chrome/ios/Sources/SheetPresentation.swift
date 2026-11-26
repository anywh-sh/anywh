import UIKit

/// Gives a sheet the theme's light or dark style, on its content and on its
/// own surface. The surface (its Liquid Glass at a partial height, its opaque
/// background at full height) follows the presentation, not the content:
/// styling only the content left light glass under the dark theme's light
/// ink, with descriptions and placeholders nearly invisible. On iOS 26 the
/// system's glass shows through; before it, the theme's background.
@MainActor
func styleSheet(_ host: UIViewController, theme: ShellTheme) {
  let background = UIColor(hex: theme.background)
  let style: UIUserInterfaceStyle = background.isDark ? .dark : .light
  host.overrideUserInterfaceStyle = style
  host.sheetPresentationController?.traitOverrides.userInterfaceStyle = style
  if #available(iOS 26, *) {
    host.view.backgroundColor = .clear
  } else {
    host.view.backgroundColor = background
  }
}

/// The user started pulling a sheet down: what it covers comes back under it
/// right away (`cover(false)`), as with a close button.
/// `presentationControllerDidDismiss` only arrives once the sheet has finished
/// sliding away, which left the bottom of the screen empty for half a second
/// on a real iPhone. Let go too early and the sheet springs back up: it
/// covers again (`cover(true)`).
@MainActor
func uncoverWhilePulledDown(_ presentationController: UIPresentationController, cover: @escaping (Bool) -> Void) {
  cover(false)
  presentationController.presentedViewController.transitionCoordinator?.animate(alongsideTransition: nil) { context in
    MainActor.assumeIsolated {
      if context.isCancelled { cover(true) }
    }
  }
}
