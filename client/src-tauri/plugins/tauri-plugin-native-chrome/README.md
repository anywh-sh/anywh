# Tauri Plugin native-chrome

Native iOS chrome around the web app. The web side owns all state, logic and
copy and sends pre-formatted payloads; the native side only draws and
captures gestures, then reports intent back as plugin events.

## Shell: drawer, top bar, blur strip

- `set_drawer` — the conversation list (SwiftUI) that sits behind the web
  canvas. The canvas (the view holding the `WKWebView`) slides right under a
  native pan that can start anywhere on screen; release settles with a spring.
  Opening and closing each have their own haptic, fired on release (not on
  landing) and also when a conversation is picked and the drawer closes.
- `set_top_bar` — the single-pill top bar (title, model, connection dot, new
  conversation) over the web content, with a blur strip fading out below it.
  Liquid Glass on iOS 26, a material on iOS 18–25. The bar's height is pushed
  to the page as the `--native-top-inset` CSS variable.
- `set_gesture_hint` — sent on `touchstart`: whether the touch began inside a
  horizontal scroller that has been scrolled, so the drawer pan stands down.

Events back to JS (`addPluginListener("native-chrome", …)`): `drawerSelect`,
`drawerProfileChange`, `drawerRetry`, `drawerRename`,
`drawerDelete`, `topBarNewConversation`.

Corner radius follows the device: `containerConcentric` on iOS 26, the
display's corner radius (private `_displayCornerRadius` key) with a safe
default on iOS 18–25.

## `show_context_menu`

Long-press menu on chat messages via `UIEditMenuInteraction` (public since iOS
16), presented at an arbitrary point from the long-press detected in JS.
Deliberately generic: any feature that needs a native menu reuses it.
