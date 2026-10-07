import SwiftRs
import Tauri
import UIKit
import WebKit

/// Native iOS chrome for the app. Two pieces:
///
/// - The shell: a conversation drawer (SwiftUI, behind) that the web canvas
///   slides away from under a native pan, plus a native top bar and a top blur
///   strip over the web content. The web side owns all state, logic and copy
///   and sends pre-formatted payloads (`setTopBar`, `setDrawer`,
///   `setGestureHint`); this side draws, captures gestures, and reports user
///   intent back as plugin events.
/// - `showContextMenu`: the long-press menu on chat messages, presented with
///   `UIEditMenuInteraction` — the only public API that shows a system-style
///   menu imperatively from an arbitrary point, which is required because the
///   content is a web view and the long-press is detected in JS.
///
/// UIKit work always hops to the main actor with `Task { @MainActor in }`
/// (plain GCD does not prove isolation to the Swift 6 compiler). The class is
/// `@unchecked Sendable` for the same reason: the Tauri bridge may call its
/// `@objc` entry points from any thread.
class NativeChromePlugin: Plugin, UIEditMenuInteractionDelegate, @unchecked Sendable {
  private var editMenuInteraction: UIEditMenuInteraction?
  private var pendingItems: [ContextMenuItemArgs] = []
  private var pendingInvoke: Invoke?
  private var pendingResolved = false

  @MainActor private let topBarStore = TopBarStore()
  @MainActor private let drawerStore = DrawerStore()
  @MainActor private let bubbleMenu = BubbleMenuController()
  @MainActor private let composerStore = ComposerStore()
  @MainActor private var composer: ComposerController?
  @MainActor private var shell: CanvasDrawerController?
  @MainActor private var lastTheme = ShellTheme.fallback

  @objc public override func load(webview: WKWebView) {
    Task { @MainActor in
      let interaction = UIEditMenuInteraction(delegate: self)
      webview.addInteraction(interaction)
      self.editMenuInteraction = interaction

      self.installPushDelegate()

      self.bubbleMenu.install(on: webview)
      self.bubbleMenu.onSelect = { [weak self] targetId, itemId in
        try? self?.trigger("contextMenuSelect", data: BubbleSelectEvent(targetId: targetId, itemId: itemId))
      }

      // The WKWebView's own outer scroll view auto-scrolls the page to bring a
      // focused input above the keyboard, which `body { position: fixed }`
      // does not stop. The app never uses that scroll view (every real scroll
      // surface is an inner DOM scroller), so disabling it removes the pan
      // without losing any scrolling.
      webview.scrollView.isScrollEnabled = false
      webview.scrollView.bounces = false

      await self.installShell(webview)
    }
  }

  /// Waits for the web view to join a window (`load` can run before that),
  /// then builds the drawer shell around it.
  @MainActor
  private func installShell(_ webview: WKWebView) async {
    for _ in 0..<50 where webview.window == nil {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    let composer = ComposerController(store: composerStore, presenter: { [weak self] in self?.manager.viewController })
    self.composer = composer
    guard let controller = CanvasDrawerController(webview: webview, topBar: topBarStore, drawer: drawerStore, composer: composer) else {
      NSLog("[native-chrome] web view never joined a window; native shell disabled")
      return
    }
    shell = controller

    topBarStore.onMenu = { [weak controller] in controller?.toggle() }
    topBarStore.onNewConversation = { [weak self] in self?.trigger("topBarNewConversation", data: JSObject()) }
    topBarStore.onModelSelect = { [weak self] modelId in
      try? self?.trigger("topBarModelSelect", data: ModelEvent(modelId: modelId))
    }
    topBarStore.onModeSelect = { [weak self] modeId in
      try? self?.trigger("topBarModeSelect", data: ModeEvent(modeId: modeId))
    }
    drawerStore.onSelect = { [weak self, weak controller] session in
      try? self?.trigger("drawerSelect", data: SessionEvent(sessionId: session.id, profileId: session.profileId))
      controller?.setOpen(false)
    }
    drawerStore.onProfileChange = { [weak self] profileId in
      try? self?.trigger("drawerProfileChange", data: ProfileEvent(profileId: profileId))
    }
    drawerStore.onRetry = { [weak self] in self?.trigger("drawerRetry", data: JSObject()) }
    drawerStore.onRename = { [weak self] session, title in
      try? self?.trigger("drawerRename", data: RenameEvent(sessionId: session.id, profileId: session.profileId, title: title))
    }
    drawerStore.onDelete = { [weak self] session in
      try? self?.trigger("drawerDelete", data: SessionEvent(sessionId: session.id, profileId: session.profileId))
    }

    wireComposer(composer)

    controller.applyTheme(lastTheme)
    controller.reportTopInset()
  }

  /// Routes what the composer reports to events for the web side.
  @MainActor
  private func wireComposer(_ composer: ComposerController) {
    let store = composerStore
    store.onTextChange = { [weak self] text in try? self?.trigger("composerTextChange", data: ComposerTextEvent(text: text)) }
    store.onFocusChange = { [weak self] focused in try? self?.trigger("composerFocusChange", data: ComposerFocusEvent(focused: focused)) }
    store.onSubmit = { [weak self] text in try? self?.trigger("composerSubmit", data: ComposerTextEvent(text: text)) }
    store.onStop = { [weak self] in self?.trigger("composerStop", data: JSObject()) }
    store.onRemoveAttachment = { [weak self] path in try? self?.trigger("composerRemoveAttachment", data: ComposerRemoveEvent(path: path)) }
    store.onCancelEdit = { [weak self] in self?.trigger("composerCancelEdit", data: JSObject()) }
    store.onTypoUse = { [weak self] in self?.trigger("composerTypoUse", data: JSObject()) }
    store.onTypoSendAnyway = { [weak self] in self?.trigger("composerTypoSendAnyway", data: JSObject()) }
    store.onScrollToEnd = { [weak self] in self?.trigger("composerScrollToEnd", data: JSObject()) }
    let attach: ([AttachedFile]) -> Void = { [weak self] files in
      try? self?.trigger("composerAttach", data: ComposerAttachEvent(files: files))
    }
    composer.onAttach = attach
    store.onPastedImages = attach
  }

  @objc func setContextTarget(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BubbleTargetArgs.self)
    Task { @MainActor in
      self.bubbleMenu.setTarget(args)
      invoke.resolve()
    }
  }

  @objc func setComposer(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ComposerArgs.self)
    Task { @MainActor in
      self.composerStore.args = args
      self.composer?.apply(args)
      invoke.resolve()
    }
  }

  @objc func setComposerText(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ComposerTextArgs.self)
    Task { @MainActor in
      self.composer?.setText(args.text)
      invoke.resolve()
    }
  }

  @objc func focusComposer(_ invoke: Invoke) throws {
    Task { @MainActor in
      self.composer?.focus()
      invoke.resolve()
    }
  }

  @objc func blurComposer(_ invoke: Invoke) throws {
    Task { @MainActor in
      self.composer?.blur()
      invoke.resolve()
    }
  }

  @objc func setComposerElapsed(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ComposerElapsedArgs.self)
    Task { @MainActor in
      self.composer?.setElapsed(args.label)
      invoke.resolve()
    }
  }

  @objc func registerForPush(_ invoke: Invoke) throws {
    Task { @MainActor in
      self.installPushDelegate()
      PushRegistration.shared.onToken = { [weak self] payload in
        try? self?.trigger("pushToken", data: payload)
      }
      do {
        invoke.resolve(try await PushRegistration.shared.register())
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  /// Takes the notification-center delegate slot, and keeps the tap event
  /// pointed at this plugin. Called at load, after the notification plugin
  /// has set itself as the delegate (it is registered first), and again on
  /// every push command in case something took the slot since.
  @MainActor private func installPushDelegate() {
    PushNotificationDelegate.shared.install()
    PushNotificationDelegate.shared.onTap = { [weak self] tap in
      try? self?.trigger("pushNotificationClicked", data: tap)
    }
  }

  @objc func setVisibleSession(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(VisibleSessionArgs.self)
    Task { @MainActor in
      self.installPushDelegate()
      PushNotificationDelegate.shared.setVisibleSession(args.sessionId)
      invoke.resolve()
    }
  }

  @objc func takePendingPushTap(_ invoke: Invoke) throws {
    Task { @MainActor in
      self.installPushDelegate()
      invoke.resolve(PendingPushTapPayload(tap: PushNotificationDelegate.shared.takePendingTap()))
    }
  }

  @objc func setScrollToEnd(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScrollToEndArgs.self)
    Task { @MainActor in
      self.composer?.setScrollToEnd(visible: args.visible, accessoryHeight: CGFloat(args.accessoryHeight))
      invoke.resolve()
    }
  }

  @objc func setTopBar(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TopBarArgs.self)
    Task { @MainActor in
      self.lastTheme = args.theme
      self.topBarStore.args = args
      self.shell?.applyTheme(args.theme)
      // The page may have reloaded since the inset was last injected.
      self.shell?.reportTopInset()
      invoke.resolve()
    }
  }

  @objc func setTopBarMenu(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(TopBarMenuArgs.self)
    Task { @MainActor in
      self.topBarStore.menu = args
      invoke.resolve()
    }
  }

  @objc func setDrawer(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DrawerArgs.self)
    Task { @MainActor in
      self.drawerStore.args = args
      invoke.resolve()
    }
  }

  @objc func setGestureHint(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GestureHintArgs.self)
    Task { @MainActor in
      self.shell?.gestureBlocked = args.blocked
      invoke.resolve()
    }
  }

  @objc func showContextMenu(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShowContextMenuArgs.self)
    Task { @MainActor in
      // A menu already pending (double long-press) is resolved as dismissed
      // first, so a JS promise is never left hanging.
      self.resolvePending(with: nil)

      guard let interaction = self.editMenuInteraction else {
        invoke.resolve(ShowContextMenuResult(selectedId: nil))
        return
      }
      self.pendingItems = args.items
      self.pendingInvoke = invoke
      self.pendingResolved = false
      let point = CGPoint(x: args.point.x, y: args.point.y)
      // `identifier` has no default in this SDK; `nil` is right when
      // configurations are never compared across calls.
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      interaction.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }
  }

  private func resolvePending(with selectedId: String?) {
    guard !pendingResolved, let invoke = pendingInvoke else { return }
    pendingResolved = true
    pendingInvoke = nil
    invoke.resolve(ShowContextMenuResult(selectedId: selectedId))
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    // UIKit calls this synchronously on the main thread; `assumeIsolated`
    // only tells the compiler what is already true at runtime.
    MainActor.assumeIsolated {
      let actions: [UIMenuElement] = pendingItems.map { item in
        var attributes: UIMenuElement.Attributes = []
        if item.disabled { attributes.insert(.disabled) }
        let action = UIAction(
          title: item.label,
          image: item.systemIcon.flatMap { UIImage(systemName: $0) },
          attributes: attributes,
          handler: { [weak self] _ in self?.resolvePending(with: item.id) }
        )
        if let reason = item.disabledReason {
          action.subtitle = reason
        }
        return action
      }
      return UIMenu(children: actions)
    }
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    willDismissMenuFor configuration: UIEditMenuConfiguration,
    animator: (any UIEditMenuInteractionAnimating)?
  ) {
    // Dismissed without picking anything; a no-op if an action already
    // resolved it (`resolvePending` is idempotent).
    resolvePending(with: nil)
  }
}

/// `Invoke` (from the Tauri package) is captured inside `Task { @MainActor in }`
/// blocks — same reasoning as the class's `@unchecked Sendable`, as a
/// retroactive conformance since the type is not ours.
extension Invoke: @unchecked Sendable {}

private struct ContextMenuItemArgs: Decodable {
  let id: String
  let label: String
  let systemIcon: String?
  let disabled: Bool
  let disabledReason: String?
}

private struct ContextMenuPointArgs: Decodable {
  let x: Double
  let y: Double
}

private struct ShowContextMenuArgs: Decodable {
  let items: [ContextMenuItemArgs]
  let point: ContextMenuPointArgs
}

private struct ShowContextMenuResult: Encodable {
  let selectedId: String?
}

@_cdecl("init_plugin_native_chrome")
func initPlugin() -> Plugin {
  return NativeChromePlugin()
}
