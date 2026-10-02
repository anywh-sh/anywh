import UIKit
import UniformTypeIdentifiers

/// Where attachments picked natively are copied before the web side reads them
/// (the plugin's `read_attachment` command, which only accepts this folder and
/// UUID file names, and deletes the file after reading).
enum AttachmentFiles {
  static let directoryName = "anywh-attachments"

  static var directory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
  }

  /// Empties the folder, so selections the web side never read don't pile up.
  static func purge() {
    try? FileManager.default.removeItem(at: directory)
  }

  private static func ensureDirectory() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  /// Copies `source` into the folder under a fresh UUID name. `displayName` is
  /// what the web side shows and uploads under. Must run before a picker's
  /// callback returns: the system deletes its own temporary copy afterwards.
  static func stage(copying source: URL, displayName: String? = nil) throws -> AttachedFile {
    try ensureDirectory()
    let ext = source.pathExtension
    let destination = directory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension(ext)
    try FileManager.default.copyItem(at: source, to: destination)
    return AttachedFile(
      path: destination.path,
      name: displayName ?? source.lastPathComponent,
      mimeType: mimeType(forExtension: ext))
  }

  static func stage(data: Data, ext: String, displayName: String) throws -> AttachedFile {
    try ensureDirectory()
    let destination = directory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension(ext)
    try data.write(to: destination)
    return AttachedFile(path: destination.path, name: displayName, mimeType: mimeType(forExtension: ext))
  }

  static func mimeType(forExtension ext: String) -> String {
    UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
  }
}
