import Tauri
import UIKit
import UserNotifications

/// Where a tapped push notification should take the app. `profileId` is the
/// profile id *on this device*, echoed back from what the app registered with
/// the relay.
struct PushTapPayload: Codable, Equatable {
  let sessionId: String
  let profileId: String?
}

/// Wire shape of `takePendingPushTap`: always an object, so "nothing pending"
/// is `{"tap": null}` rather than a bare null the bridge may drop.
struct PendingPushTapPayload: Encodable {
  let tap: PushTapPayload?
}

/// Carries a value across an actor hop that the compiler cannot prove safe.
/// Only used for the system's completion handlers below: UserNotifications
/// hands them to a delegate method on whatever thread it likes and requires
/// each to be called exactly once, from anywhere — they are not data that two
/// threads touch.
private struct UncheckedSendable<Value>: @unchecked Sendable {
  let value: Value
}

/// Receives remote notifications while still handing local ones to whoever
/// owned the notification-center delegate before.
///
/// `UNUserNotificationCenter` has exactly one delegate, and the notification
/// plugin the app already ships sets itself as that delegate: it answers
/// `willPresent` with "show nothing" for a remote notification and never
/// tells the web side about a tap on one. This object takes the slot,
/// remembers the previous delegate, forwards every non-push call to it
/// untouched (local notifications keep behaving exactly as before), and
/// handles the push ones itself.
///
/// All state lives on the main actor; UserNotifications calls hop there.
@MainActor
final class PushNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PushNotificationDelegate()

  /// Fired for a tap once the web side has said it is listening.
  var onTap: ((PushTapPayload) -> Void)?

  /// Which session the person is looking at right now (`nil`: none), as the
  /// web side reports it. A push for that session is not shown in the
  /// foreground.
  private(set) var visibleSessionId: String?

  /// A tap that arrived before the web side was listening (a cold start: the
  /// system delivers the tap while the page is still loading).
  private var pendingTap: PushTapPayload?
  private var webReady = false
  private var previous: UNUserNotificationCenterDelegate?

  /// Takes the notification-center delegate slot, remembering whoever held
  /// it. Safe to call again: if something else took the slot since, this
  /// takes it back (and remembers *that* one), and if it is already ours
  /// nothing changes.
  func install() {
    let center = UNUserNotificationCenter.current()
    guard center.delegate !== self else { return }
    previous = center.delegate
    center.delegate = self
  }

  func setVisibleSession(_ id: String?) {
    visibleSessionId = id
  }

  /// The web side's handshake on mount: hands over a tap that arrived before
  /// it was listening, and from now on taps are delivered as events instead
  /// of being held.
  func takePendingTap() -> PushTapPayload? {
    webReady = true
    defer { pendingTap = nil }
    return pendingTap
  }

  // MARK: - UNUserNotificationCenterDelegate

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let done = UncheckedSendable(value: completionHandler)
    let carried = UncheckedSendable(value: (center, notification))
    guard Self.isRemote(notification) else {
      Task { @MainActor in self.forwardWillPresent(carried.value.0, carried.value.1, done.value) }
      return
    }
    let sessionId = Self.tap(from: notification.request.content.userInfo)?.sessionId
    Task { @MainActor in
      done.value(Self.presentation(
        appIsActive: UIApplication.shared.applicationState == .active,
        pushSessionId: sessionId,
        visibleSessionId: self.visibleSessionId
      ))
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let done = UncheckedSendable(value: completionHandler)
    let carried = UncheckedSendable(value: (center, response))
    guard Self.isRemote(response.notification) else {
      Task { @MainActor in self.forwardDidReceive(carried.value.0, carried.value.1, done.value) }
      return
    }
    let tap = Self.tap(from: response.notification.request.content.userInfo)
    Task { @MainActor in
      if let tap { self.deliver(tap) }
      done.value()
    }
  }

  private func deliver(_ tap: PushTapPayload) {
    if webReady, let onTap {
      onTap(tap)
    } else {
      pendingTap = tap
    }
  }

  // MARK: - Pure decisions

  /// What to do with a remote notification that arrives while the app runs:
  /// stay silent when it is about the session already on screen, show it
  /// otherwise. (A notification that arrives while the app is in the
  /// background never reaches `willPresent`; the system shows it.)
  nonisolated static func presentation(
    appIsActive: Bool,
    pushSessionId: String?,
    visibleSessionId: String?
  ) -> UNNotificationPresentationOptions {
    if appIsActive, let pushSessionId, pushSessionId == visibleSessionId { return [] }
    return [.banner, .list, .sound]
  }

  /// The routing fields of a push payload (they sit beside `aps`, not inside
  /// it). `nil` when there is no session to route to.
  nonisolated static func tap(from userInfo: [AnyHashable: Any]) -> PushTapPayload? {
    guard let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty else { return nil }
    return PushTapPayload(sessionId: sessionId, profileId: userInfo["profileId"] as? String)
  }

  nonisolated private static func isRemote(_ notification: UNNotification) -> Bool {
    notification.request.trigger is UNPushNotificationTrigger
  }

  // MARK: - Forwarding

  private func forwardWillPresent(
    _ center: UNUserNotificationCenter,
    _ notification: UNNotification,
    _ completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let selector = #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))
    if let previous, previous.responds(to: selector) {
      previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
    } else {
      // Nobody before us implemented it: the system's own default for a
      // delegate that does not implement it is to show nothing.
      completionHandler([])
    }
  }

  private func forwardDidReceive(
    _ center: UNUserNotificationCenter,
    _ response: UNNotificationResponse,
    _ completionHandler: @escaping () -> Void
  ) {
    let selector = #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))
    if let previous, previous.responds(to: selector) {
      previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
    } else {
      completionHandler()
    }
  }
}

struct VisibleSessionArgs: Decodable {
  let sessionId: String?
}
