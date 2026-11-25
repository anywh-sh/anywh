import SwiftUI
import UIKit

// Payloads for the pending question (an agent's question or an approval). Like
// the rest of the shell, everything arrives worded and translated, and the web
// side owns the answer being built: nothing here decides or translates.

struct ChoiceBanner: Decodable {
  let label: String
  let text: String
  let openLabel: String
}

struct ChoiceOptionRow: Decodable {
  let label: String
  let description: String?
  let selected: Bool
}

struct ChoiceCustomField: Decodable {
  let text: String
  let placeholder: String
  let label: String
  let secret: Bool
}

struct ChoiceStrings: Decodable {
  let close: String
  let previous: String
}

/// One step (question) of the pending prompt.
struct ChoiceSheetArgs: Decodable {
  let stepKey: String
  let banner: ChoiceBanner
  let kicker: String
  let position: String?
  let question: String
  let multiSelect: Bool
  let options: [ChoiceOptionRow]
  let optionsDimmed: Bool
  let custom: ChoiceCustomField?
  let canGoBack: Bool
  let canAnswer: Bool
  let status: String?
  let submitLabel: String
  let skipLabel: String
  let strings: ChoiceStrings
  let theme: ShellTheme
}

/// `choice == nil`: nothing is pending.
struct ChoiceArgs: Decodable {
  let choice: ChoiceSheetArgs?
}

// Events sent back to the web side.

struct ChoiceToggleEvent: Encodable {
  let index: Int
}

struct ChoiceTextEvent: Encodable {
  let text: String
}

/// State behind the composer's pending-question row and the question sheet,
/// plus what their views report. The plugin wires the reports to events for the
/// web side; the sheet controller handles opening and closing.
@MainActor
final class ChoiceStore: ObservableObject {
  @Published private(set) var args: ChoiceSheetArgs?
  /// The last question there was. The sheet keeps drawing it while it slides
  /// away after the question is gone (answered), instead of going blank.
  private(set) var lastArgs: ChoiceSheetArgs?
  /// The free-text field. It belongs to this side while the user types: the
  /// payload only writes it when the step changes, and a tap on an option
  /// empties it (the web side drops the text on that tap too).
  @Published var customText = ""
  /// Bumped on every new step, so the sheet scrolls back to the top.
  @Published private(set) var stepVersion = 0

  /// Heights of the sheet's parts, measured by its view; their sum is the
  /// height of the sheet's fitted detent.
  var headerHeight: CGFloat = 0
  var contentHeight: CGFloat = 0
  var footerHeight: CGFloat = 0
  var fittedHeight: CGFloat { headerHeight + contentHeight + footerHeight }

  var onOpen: () -> Void = {}
  var onClose: () -> Void = {}
  var onFieldFocus: () -> Void = {}
  var onMeasure: () -> Void = {}
  var onToggle: (Int) -> Void = { _ in }
  var onCustomTextChange: (String) -> Void = { _ in }
  var onPrevious: () -> Void = {}
  var onSubmit: () -> Void = {}
  var onSkip: () -> Void = {}

  /// Takes a payload in. Returns whether the step changed.
  @discardableResult
  func apply(_ next: ChoiceSheetArgs?) -> Bool {
    let stepChanged = next?.stepKey != args?.stepKey
    args = next
    // Going away (`nil`) leaves the field and the scroll as they were: the
    // sheet still shows them while it slides down.
    guard let next else { return stepChanged }
    lastArgs = next
    if stepChanged {
      customText = next.custom?.text ?? ""
      stepVersion += 1
    }
    return stepChanged
  }

  /// A typed edit: kept here and reported. Programmatic writes (`apply`)
  /// skip this, so the web side never hears its own text back.
  func editCustomText(_ text: String) {
    customText = text
    onCustomTextChange(text)
  }

  func toggle(_ index: Int) {
    customText = ""
    onToggle(index)
  }
}
