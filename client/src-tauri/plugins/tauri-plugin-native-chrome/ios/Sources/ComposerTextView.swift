import SwiftUI
import UIKit

/// The composer's text field: a plain `UITextView` that reports its own height,
/// shows a placeholder, and turns an image on the pasteboard into an attachment.
/// Native text is plain text with `\n`, so nothing here needs the web editor's
/// line-break workarounds.
final class ComposerUITextView: UITextView {
  static let font = UIFont.systemFont(ofSize: 16)

  private let placeholderLabel = UILabel()
  private var lastReported: (height: CGFloat, width: CGFloat) = (0, 0)

  /// Largest height before the field scrolls inside itself.
  var maxHeight: CGFloat = 160
  /// Called (async, never mid-layout) when the content height or width changed.
  var onMetrics: ((_ contentHeight: CGFloat) -> Void)?
  var onPasteImages: (([UIImage]) -> Void)?
  /// Take focus as soon as the view joins a window (a focus request can
  /// arrive before the field has been put on screen).
  var focusWhenAttached = false

  init() {
    super.init(frame: .zero, textContainer: nil)
    font = Self.font
    backgroundColor = .clear
    isScrollEnabled = false
    textContainerInset = .zero
    textContainer.lineFragmentPadding = 0
    // Plain text only; nothing the web side's wire format couldn't carry.
    allowsEditingTextAttributes = false
    returnKeyType = .default

    placeholderLabel.font = Self.font
    placeholderLabel.numberOfLines = 1
    placeholderLabel.isUserInteractionEnabled = false
    addSubview(placeholderLabel)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func setPlaceholder(_ text: String, color: UIColor) {
    placeholderLabel.text = text
    placeholderLabel.textColor = color
    setNeedsLayout()
  }

  func refreshPlaceholder() {
    placeholderLabel.isHidden = !text.isEmpty
  }

  /// Programmatic replacement. Doesn't notify the delegate (UIKit only does
  /// that for edits by the user), which is what keeps the web side's draft from
  /// echoing its own text back. The cursor goes to the end.
  func setText(_ value: String) {
    text = value
    selectedRange = NSRange(location: (value as NSString).length, length: 0)
    refreshPlaceholder()
    setNeedsLayout()
    layoutIfNeeded()
    scrollRangeToVisible(selectedRange)
  }

  /// Height the content needs at `width`, at least one line.
  func contentHeight(for width: CGFloat) -> CGFloat {
    let fitted = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    return max(fitted, Self.font.lineHeight.rounded(.up))
  }

  var singleLineHeight: CGFloat { Self.font.lineHeight.rounded(.up) }

  override func layoutSubviews() {
    super.layoutSubviews()
    let size = placeholderLabel.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
    placeholderLabel.frame = CGRect(x: 0, y: 0, width: bounds.width, height: size.height)
    refreshPlaceholder()

    guard bounds.width > 0 else { return }
    let height = contentHeight(for: bounds.width)
    let shouldScroll = height > maxHeight + 0.5
    if isScrollEnabled != shouldScroll { isScrollEnabled = shouldScroll }
    if lastReported.height != height || lastReported.width != bounds.width {
      lastReported = (height, bounds.width)
      // Deferred so the store's state is never mutated in the middle of a layout pass.
      Task { @MainActor [weak self] in self?.onMetrics?(height) }
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil, focusWhenAttached {
      focusWhenAttached = false
      becomeFirstResponder()
    }
  }

  // MARK: Paste

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    // An image alone is an attachment; text (even alongside an image, as a web
    // page copy provides) pastes as text.
    if UIPasteboard.general.hasImages, !UIPasteboard.general.hasStrings,
      let images = UIPasteboard.general.images, !images.isEmpty
    {
      onPasteImages?(images)
      return
    }
    super.paste(sender)
  }
}

struct ComposerTextField: UIViewRepresentable {
  @ObservedObject var store: ComposerStore
  let placeholder: String
  let foreground: UIColor
  let muted: UIColor
  let tint: UIColor

  func makeUIView(context: Context) -> ComposerUITextView {
    let view = ComposerUITextView()
    view.delegate = context.coordinator
    view.onMetrics = { [weak store, weak view] contentHeight in
      guard let store, let view else { return }
      let multiline = contentHeight > view.singleLineHeight + 2
      if store.multiline != multiline { store.multiline = multiline }
    }
    view.onPasteImages = { [weak store] images in
      let files = images.compactMap { image -> AttachedFile? in
        guard let data = image.pngData() else { return nil }
        return try? AttachmentFiles.stage(data: data, ext: "png", displayName: "pasted-image.png")
      }
      if !files.isEmpty { store?.onPastedImages(files) }
    }
    store.textView = view
    if let pending = store.pendingText {
      view.setText(pending)
      store.pendingText = nil
    }
    if store.pendingFocus {
      view.focusWhenAttached = true
      store.pendingFocus = false
    }
    view.setContentHuggingPriority(.defaultLow, for: .horizontal)
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }

  func updateUIView(_ view: ComposerUITextView, context: Context) {
    view.textColor = foreground
    view.tintColor = tint
    view.maxHeight = store.maxFieldHeight
    view.setPlaceholder(placeholder, color: muted)
    context.coordinator.store = store
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context) -> CGSize? {
    let width = proposal.width ?? 240
    let height = min(uiView.contentHeight(for: width), store.maxFieldHeight)
    return CGSize(width: width, height: height)
  }

  func makeCoordinator() -> Coordinator { Coordinator(store: store) }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var store: ComposerStore

    init(store: ComposerStore) { self.store = store }

    func textViewDidChange(_ textView: UITextView) {
      (textView as? ComposerUITextView)?.refreshPlaceholder()
      store.onTextChange(textView.text)
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      store.focused = true
      store.onFocusChange(true)
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      store.focused = false
      store.onFocusChange(false)
    }
  }
}
