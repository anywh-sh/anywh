import SwiftUI
import UIKit

/// Tunables for the question sheet, in one place for on-device tuning.
private enum SheetTuning {
  static let sideInset: CGFloat = 20
  /// Room above the header for the sheet's grabber.
  static let headerTop: CGFloat = 20
  static let corner: CGFloat = 16
  static let rowMinHeight: CGFloat = 52
  static let buttonHeight: CGFloat = 50
  static let roundButton: CGFloat = 34
  /// How much the options fade while free text is the answer.
  static let dimmedOpacity: Double = 0.45
}

/// The pending question as a native sheet: a small label (the question's
/// header or the kind of prompt) and its position, the question itself and
/// the options as large rows; pinned at the bottom, the free-text field when
/// the question takes one, and skip / next-or-send. Opened from the
/// composer's row by `ChoiceSheetController`; everything it shows comes
/// worded from the web side, and every tap goes back to it through the store.
struct ChoiceSheetView: View {
  @ObservedObject var store: ChoiceStore
  @FocusState private var fieldFocused: Bool
  private let topID = "choice-sheet-top"

  var body: some View {
    if let args = store.args ?? store.lastArgs {
      let theme = args.theme
      VStack(spacing: 0) {
        header(args, theme)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measure(\.headerHeight, $0) }
        ScrollViewReader { proxy in
          ScrollView {
            content(args, theme)
              .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measure(\.contentHeight, $0) }
          }
          .scrollBounceBehavior(.basedOnSize)
          .scrollDismissesKeyboard(.interactively)
          .onChange(of: store.stepVersion) {
            proxy.scrollTo(topID, anchor: .top)
          }
        }
        footer(args, theme)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measure(\.footerHeight, $0) }
      }
      .onChange(of: fieldFocused) { _, focused in
        if focused { store.onFieldFocus() }
      }
    }
  }

  /// Keeps the store's measurement of one part of the sheet, telling the
  /// controller only when it really moved (the fitted detent follows it).
  private func measure(_ part: ReferenceWritableKeyPath<ChoiceStore, CGFloat>, _ value: CGFloat) {
    guard abs(store[keyPath: part] - value) > 0.5 else { return }
    store[keyPath: part] = value
    store.onMeasure()
  }

  // MARK: Header

  private func header(_ args: ChoiceSheetArgs, _ theme: ShellTheme) -> some View {
    HStack(spacing: 10) {
      if args.canGoBack {
        roundButton("chevron.left", label: args.strings.previous, theme: theme) { store.onPrevious(args.stepKey) }
      }
      HStack(spacing: 8) {
        Text(args.kicker)
          .font(.system(size: 12.5, weight: .medium, design: .monospaced))
          .foregroundStyle(Color(hex: theme.primary))
          .lineLimit(1)
        if let position = args.position {
          Text(position)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(Color(hex: theme.muted))
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      roundButton("xmark", label: args.strings.close, theme: theme) { store.onClose() }
    }
    .padding(.leading, args.canGoBack ? 12 : SheetTuning.sideInset)
    .padding(.trailing, 12)
    .padding(.top, SheetTuning.headerTop)
    .padding(.bottom, 8)
  }

  private func roundButton(_ symbol: String, label: String, theme: ShellTheme, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Color(hex: theme.muted))
        .frame(width: SheetTuning.roundButton, height: SheetTuning.roundButton)
        .background(Circle().fill(Color(hex: theme.foreground).opacity(0.08)))
        .frame(width: 44, height: 44)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  // MARK: Content

  private func content(_ args: ChoiceSheetArgs, _ theme: ShellTheme) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(args.question)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(Color(hex: theme.foreground))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(topID)
      if !args.options.isEmpty {
        VStack(spacing: 8) {
          ForEach(Array(args.options.enumerated()), id: \.offset) { index, option in
            optionRow(index, option, step: args.stepKey, multiSelect: args.multiSelect, theme: theme)
          }
        }
        .opacity(args.optionsDimmed ? SheetTuning.dimmedOpacity : 1)
      }
    }
    .padding(.horizontal, SheetTuning.sideInset)
    .padding(.top, 2)
    .padding(.bottom, 16)
  }

  private func optionRow(_ index: Int, _ option: ChoiceOptionRow, step: String, multiSelect: Bool, theme: ShellTheme) -> some View {
    let shape = RoundedRectangle(cornerRadius: SheetTuning.corner, style: .continuous)
    let primary = Color(hex: theme.primary)
    let ink = Color(hex: theme.foreground)
    return Button {
      fieldFocused = false
      store.toggle(index, step: step)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Image(systemName: indicator(selected: option.selected, multiSelect: multiSelect))
          .font(.system(size: 19))
          .foregroundStyle(option.selected ? primary : Color(hex: theme.faint))
        VStack(alignment: .leading, spacing: 3) {
          Text(option.label)
            .font(.system(size: 16))
            .foregroundStyle(ink)
          if let description = option.description {
            Text(description)
              .font(.system(size: 13.5))
              .foregroundStyle(Color(hex: theme.muted))
          }
        }
        .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 13)
      .frame(minHeight: SheetTuning.rowMinHeight)
      .background(shape.fill(option.selected ? primary.opacity(0.12) : ink.opacity(0.05)))
      .overlay(shape.strokeBorder(option.selected ? primary : ink.opacity(0.1), lineWidth: option.selected ? 1.5 : 1))
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(option.selected ? .isSelected : [])
  }

  private func indicator(selected: Bool, multiSelect: Bool) -> String {
    if multiSelect { return selected ? "checkmark.square.fill" : "square" }
    return selected ? "checkmark.circle.fill" : "circle"
  }

  @ViewBuilder
  private func customField(_ custom: ChoiceCustomField, step: String, _ theme: ShellTheme) -> some View {
    let shape = RoundedRectangle(cornerRadius: SheetTuning.corner, style: .continuous)
    let ink = Color(hex: theme.foreground)
    let primary = Color(hex: theme.primary)
    // The setter only runs on the user's own edits, so the web side never
    // hears back a text it sent.
    let text = Binding(get: { store.customText }, set: { store.editCustomText($0, step: step) })
    let prompt = Text(custom.placeholder).foregroundStyle(Color(hex: theme.muted))
    Group {
      if custom.secret {
        SecureField(custom.label, text: text, prompt: prompt)
      } else {
        TextField(custom.label, text: text, prompt: prompt)
      }
    }
    .font(.system(size: 16))
    .foregroundStyle(ink)
    .tint(primary)
    .focused($fieldFocused)
    .submitLabel(.send)
    // Return sends only what was typed, like Enter in the web card's field.
    .onSubmit {
      if !store.customText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { store.onSubmit(step) }
    }
    .padding(.horizontal, 14)
    .frame(minHeight: SheetTuning.rowMinHeight)
    .background(shape.fill(ink.opacity(0.05)))
    .overlay(shape.strokeBorder(fieldFocused ? primary : ink.opacity(0.1), lineWidth: fieldFocused ? 1.5 : 1))
  }

  // MARK: Footer

  /// Pinned under the scrolled options, so it rides above the keyboard: the
  /// free-text field (when the question takes one) is always in full view
  /// while it is being typed in.
  private func footer(_ args: ChoiceSheetArgs, _ theme: ShellTheme) -> some View {
    VStack(spacing: 10) {
      if let custom = args.custom {
        customField(custom, step: args.stepKey, theme)
      }
      if let status = args.status {
        Text(status)
          .font(.system(size: 13))
          .foregroundStyle(Color(hex: theme.muted))
          .frame(maxWidth: .infinity)
      }
      HStack(spacing: 8) {
        Button { store.onSkip(args.stepKey) } label: {
          Text(args.skipLabel)
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(Color(hex: theme.muted))
            // Its text lines up with the options' indicators and the field's
            // text above it.
            .padding(.leading, 14)
            .padding(.trailing, 18)
            .frame(height: SheetTuning.buttonHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!args.canAnswer)
        .opacity(args.canAnswer ? 1 : 0.4)
        Button { store.onSubmit(args.stepKey) } label: {
          Text(args.submitLabel)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Color(hex: theme.primaryForeground))
            .frame(maxWidth: .infinity)
            .frame(height: SheetTuning.buttonHeight)
            .background(Capsule().fill(Color(hex: theme.primary)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!args.canAnswer)
        .opacity(args.canAnswer ? 1 : 0.4)
      }
    }
    .padding(.horizontal, SheetTuning.sideInset)
    .padding(.top, 6)
    .padding(.bottom, 12)
  }
}
