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

// Events sent back to the web side. Each names the question it was made on
// (`stepKey`), so the web side can drop one that lands after the sheet moved
// on (the second tap of a double tap on Next).

struct ChoiceToggleEvent: Encodable {
  let stepKey: String
  let index: Int
}

struct ChoiceTextEvent: Encodable {
  let stepKey: String
  let text: String
}

struct ChoiceStepEvent: Encodable {
  let stepKey: String
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
  /// Each report carries the `stepKey` of the question it was made on.
  var onToggle: (String, Int) -> Void = { _, _ in }
  var onCustomTextChange: (String, String) -> Void = { _, _ in }
  var onPrevious: (String) -> Void = { _ in }
  var onSubmit: (String) -> Void = { _ in }
  var onSkip: (String) -> Void = { _ in }

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
  func editCustomText(_ text: String, step: String) {
    customText = text
    onCustomTextChange(step, text)
  }

  func toggle(_ index: Int, step: String) {
    // A tap on a question already gone is dropped on the web side, so the
    // field of the one now on screen keeps its text.
    if step == args?.stepKey { customText = "" }
    onToggle(step, index)
  }
}
