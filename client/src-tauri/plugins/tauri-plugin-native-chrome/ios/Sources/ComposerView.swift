import SwiftUI
import UIKit

/// Decoded thumbnails, keyed by attachment id, so a re-render never decodes the
/// same data URL twice.
private enum ThumbnailCache {
  nonisolated(unsafe) private static let cache = NSCache<NSString, UIImage>()

  static func image(for attachment: ComposerAttachment) -> UIImage? {
    guard let dataURL = attachment.thumbnail else { return nil }
    let key = attachment.path as NSString
    if let cached = cache.object(forKey: key) { return cached }
    guard
      let comma = dataURL.firstIndex(of: ","),
      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
      let image = UIImage(data: data)
    else { return nil }
    cache.setObject(image, forKey: key)
    return image
  }
}

/// The native composer: one glass surface holding the banners, the attachment
/// chips and the `[attach] [text] [send | stop]` row. A pill with one line, a
/// continuous rounded rectangle once it grows.
struct ComposerView: View {
  @ObservedObject var store: ComposerStore

  var body: some View {
    if let args = store.args {
      let theme = args.theme
      let expanded = store.multiline || args.editBanner != nil || args.typo != nil || !args.attachments.isEmpty || args.uploading
      VStack(alignment: .leading, spacing: 6) {
        if let banner = args.editBanner { editBanner(banner, theme) }
        if let typo = args.typo { typoBanner(typo, theme) }
        if !args.attachments.isEmpty || args.uploading { chips(args, theme) }
        inputRow(args, theme)
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
      .glassBackground(
        RoundedRectangle(cornerRadius: expanded ? 22 : 26, style: .continuous),
        tint: Color(hex: theme.tint)
      )
      .animation(.easeInOut(duration: 0.2), value: expanded)
    }
  }

  // MARK: Input row

  private func inputRow(_ args: ComposerArgs, _ theme: ShellTheme) -> some View {
    HStack(alignment: store.multiline ? .bottom : .center, spacing: 4) {
      attachButton(args, theme)
      ComposerTextField(
        store: store,
        placeholder: args.placeholder,
        foreground: UIColor(hex: theme.foreground),
        muted: UIColor(hex: theme.muted),
        tint: UIColor(hex: theme.primary)
      )
      .padding(.vertical, store.multiline ? 12 : 0)
      sendButton(args, theme)
    }
    .frame(minHeight: 44)
  }

  private func attachButton(_ args: ComposerArgs, _ theme: ShellTheme) -> some View {
    Menu {
      Button {
        store.onAttachPhotos()
      } label: {
        Label(args.strings.attachPhotos, systemImage: "photo.on.rectangle")
      }
      Button {
        store.onAttachFiles()
      } label: {
        Label(args.strings.attachFiles, systemImage: "folder")
      }
    } label: {
      Image(systemName: "paperclip")
        .font(.system(size: 18, weight: .regular))
        .foregroundStyle(Color(hex: theme.muted))
        .frame(width: 40, height: 44)
        .contentShape(Rectangle())
    }
    .disabled(!args.attachEnabled)
    .opacity(args.attachEnabled ? 1 : 0.4)
    .accessibilityLabel(args.strings.attach)
  }

  @ViewBuilder
  private func sendButton(_ args: ComposerArgs, _ theme: ShellTheme) -> some View {
    Group {
      if args.turnInFlight {
        Button {
          store.onStop()
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "stop.fill").font(.system(size: 12))
            if let elapsed = store.elapsed {
              Text(elapsed).font(.system(size: 12, design: .monospaced))
            }
          }
          .foregroundStyle(Color(hex: theme.muted))
          .padding(.horizontal, 12)
          .frame(height: 36)
          .overlay(Capsule().strokeBorder(Color(hex: theme.border), lineWidth: 1))
          .contentShape(Capsule())
        }
        .accessibilityLabel(args.strings.stop)
      } else {
        Button {
          store.onSubmit(store.textView?.text ?? "")
        } label: {
          Image(systemName: "arrow.up")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Color(hex: args.canSend ? theme.primaryForeground : theme.faint))
            .frame(width: 36, height: 36)
            .background(Circle().fill(Color(hex: args.canSend ? theme.primary : theme.border)))
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .disabled(!args.canSend)
        .accessibilityLabel(args.strings.send)
      }
    }
    .buttonStyle(.plain)
  }

  // MARK: Banners

  private func editBanner(_ banner: ComposerEditBanner, _ theme: ShellTheme) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "pencil")
        .font(.system(size: 12))
        .foregroundStyle(Color(hex: theme.muted))
        .padding(.top, 2)
      Text(banner.text)
        .font(.system(size: 12.5))
        .foregroundStyle(Color(hex: theme.muted))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button {
        store.onCancelEdit()
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Color(hex: theme.muted))
          .frame(width: 44, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(banner.cancelLabel)
    }
    .padding(.leading, 12)
    .padding(.top, 6)
  }

  private func typoBanner(_ typo: ComposerTypo, _ theme: ShellTheme) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      (Text(typo.before)
        + Text(typo.command).font(.system(size: 12.5, design: .monospaced)).foregroundColor(Color(hex: theme.foreground))
        + Text(typo.after))
        .font(.system(size: 12.5))
        .foregroundStyle(Color(hex: theme.muted))
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 4) {
        Button(typo.useLabel) { store.onTypoUse() }
          .foregroundStyle(Color(hex: theme.primary))
        Button(typo.sendAnywayLabel) { store.onTypoSendAnyway() }
          .foregroundStyle(Color(hex: theme.muted))
      }
      .font(.system(size: 13, weight: .medium))
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 12)
    .padding(.top, 6)
  }

  // MARK: Attachments

  private func chips(_ args: ComposerArgs, _ theme: ShellTheme) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(args.attachments) { attachment in
          chip(attachment, args, theme)
        }
        if args.uploading {
          HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text(args.strings.uploading)
              .font(.system(size: 11.5, design: .monospaced))
              .foregroundStyle(Color(hex: theme.muted))
              .lineLimit(1)
          }
          .padding(.horizontal, 6)
        }
      }
      .padding(.horizontal, 8)
      // Room for the remove button hanging off each thumbnail's corner.
      .padding(.top, 8)
      .padding(.trailing, 8)
    }
    .scrollClipDisabled()
  }

  @ViewBuilder
  private func chip(_ attachment: ComposerAttachment, _ args: ComposerArgs, _ theme: ShellTheme) -> some View {
    if let image = ThumbnailCache.image(for: attachment) {
      Image(uiImage: image)
        .resizable()
        .scaledToFill()
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .bottomLeading) {
          if attachment.isVideo {
            Image(systemName: "video.fill")
              .font(.system(size: 9))
              .foregroundStyle(.white)
              .padding(4)
              .background(Circle().fill(.black.opacity(0.55)))
              .padding(3)
          }
        }
        .overlay(alignment: .topTrailing) { removeButton(attachment, args, theme).offset(x: 8, y: -8) }
    } else {
      HStack(spacing: 6) {
        Image(systemName: attachment.isVideo ? "video" : "doc")
          .font(.system(size: 12))
          .foregroundStyle(Color(hex: theme.primary))
        Text(attachment.name)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(Color(hex: theme.muted))
          .lineLimit(1)
          .frame(maxWidth: 140)
      }
      .padding(.horizontal, 10)
      .frame(height: 36)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(hex: theme.border).opacity(0.5)))
      .overlay(alignment: .topTrailing) { removeButton(attachment, args, theme).offset(x: 8, y: -8) }
    }
  }

  /// 22pt visible, 44pt to hit.
  private func removeButton(_ attachment: ComposerAttachment, _ args: ComposerArgs, _ theme: ShellTheme) -> some View {
    Button {
      store.onRemoveAttachment(attachment.path)
    } label: {
      Image(systemName: "xmark")
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(Color(hex: theme.foreground))
        .frame(width: 22, height: 22)
        .background(Circle().fill(Color(hex: theme.elevated)))
        .overlay(Circle().strokeBorder(Color(hex: theme.border), lineWidth: 1))
        .frame(width: 44, height: 44)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(args.strings.removeAttachment)
  }
}
