import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Collects files that arrive on background queues, keeping the order the user
/// picked them in, and fires once when the last one is in.
private final class FileCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var slots: [AttachedFile?]
  private var remaining: Int

  init(count: Int) {
    slots = Array(repeating: nil, count: count)
    remaining = count
  }

  /// Returns the files (in pick order) when this was the last outstanding one.
  func finish(index: Int, file: AttachedFile?) -> [AttachedFile]? {
    lock.lock()
    defer { lock.unlock() }
    slots[index] = file
    remaining -= 1
    return remaining == 0 ? slots.compactMap { $0 } : nil
  }
}

/// Photos and Files pickers for the composer's attach menu. Each chosen item
/// is copied into the attachments folder right away (the system's temporary
/// copy disappears once the callback returns) and handed to `onFiles`; the web
/// side reads the bytes from there and does the upload.
@MainActor
final class AttachmentPicker: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
  var onFiles: ([AttachedFile]) -> Void = { _ in }

  func presentPhotos(from presenter: UIViewController) {
    var configuration = PHPickerConfiguration()
    configuration.filter = .any(of: [.images, .videos])
    configuration.selectionLimit = 0
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    presenter.present(picker, animated: true)
  }

  func presentFiles(from presenter: UIViewController) {
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image, .movie], asCopy: true)
    picker.allowsMultipleSelection = true
    picker.delegate = self
    presenter.present(picker, animated: true)
  }

  // MARK: PHPickerViewControllerDelegate

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard !results.isEmpty else { return }
    let collector = FileCollector(count: results.count)
    for (index, result) in results.enumerated() {
      let provider = result.itemProvider
      let typeIdentifier = Self.typeToLoad(for: provider)
      provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, _ in
        // Still on the system's callback queue: copy before returning.
        let file = url.flatMap { try? AttachmentFiles.stage(copying: $0) }
        guard let files = collector.finish(index: index, file: file), !files.isEmpty else { return }
        Task { @MainActor in self?.onFiles(files) }
      }
    }
  }

  /// A video as is; an image as PNG or GIF when it already is one, otherwise as
  /// JPEG — Photos hands out HEIC, which the system web view used to convert
  /// for the old file input and which the agent can't read.
  private static func typeToLoad(for provider: NSItemProvider) -> String {
    if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) { return UTType.movie.identifier }
    let registered = provider.registeredTypeIdentifiers
    if registered.contains(UTType.png.identifier) { return UTType.png.identifier }
    if registered.contains(UTType.gif.identifier) { return UTType.gif.identifier }
    return UTType.jpeg.identifier
  }

  // MARK: UIDocumentPickerDelegate

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    let files = urls.compactMap { try? AttachmentFiles.stage(copying: $0) }
    if !files.isEmpty { onFiles(files) }
  }
}
