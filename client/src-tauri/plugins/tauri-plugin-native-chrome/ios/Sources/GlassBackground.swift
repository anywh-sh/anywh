import SwiftUI

extension View {
  /// The shared glass of the native chrome: Liquid Glass on iOS 26, a blurred
  /// material with a hairline and a soft shadow before it. The top bar pill,
  /// the composer and the scroll-to-end button all go through here so they
  /// read as one material.
  @ViewBuilder
  func glassBackground<S: InsettableShape>(_ shape: S, tint: Color) -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(.regular, in: shape)
    } else {
      self
        .background(.ultraThinMaterial, in: shape)
        .overlay(shape.strokeBorder(tint.opacity(0.08), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
    }
  }
}
