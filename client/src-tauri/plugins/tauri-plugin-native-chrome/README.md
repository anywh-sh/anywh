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

## Composer

The message composer is native too: a glass surface (Liquid Glass on iOS 26,
a material on iOS 18–25) with a plain `UITextView`, the attach menu, and
send/stop. Everything it shows arrives in one payload; the text itself lives
only in the field.

- `set_composer` — the full payload (strings, `canSend`, `turnInFlight`,
  attachment chips, edit/typo banners, `hidden`, theme). Sent when it changes,
  not on every keystroke.
- `set_composer_text` — imperative text replacement (draft restore, edit
  start/cancel, clear after send). Never part of the payload, so it can't
  overwrite what the user is typing; the cursor goes to the end and no
  `composerTextChange` echoes back.
- `focus_composer` / `blur_composer`, `set_composer_elapsed` (the turn clock's
  label, formatted by the web side), `set_scroll_to_end` (visibility of the
  round arrow, plus the height of the web stack floating above the composer).
- `read_attachment` — Rust only: reads and deletes a file the Photos / Files
  pickers copied into `<tmp>/anywh-attachments/`, returning raw bytes. It
  accepts only UUID-named files directly inside that folder (symlinks and `..`
  are resolved first), so it can't read arbitrary paths. The upload itself
  stays on the web side.

The composer sits above the web view, pinned to `keyboardLayoutGuide`, with a
strip under it (the theme background at about 18%, fading out above the
composer) so text scrolling underneath recedes. The room the strip and the
composer take, keyboard included, is pushed to the page as the
`--native-bottom-inset` CSS variable (removed while the composer is hidden).
Touches that begin in the composer or on the arrow never feed the drawer pan.

Events back to JS: `composerTextChange`, `composerFocusChange`,
`composerSubmit`, `composerStop`, `composerAttach`, `composerRemoveAttachment`,
`composerCancelEdit`, `composerTypoUse`, `composerTypoSendAnyway`,
`composerScrollToEnd`.

## `show_context_menu`

Long-press menu on chat messages via `UIEditMenuInteraction` (public since iOS
16), presented at an arbitrary point from the long-press detected in JS.
Deliberately generic: any feature that needs a native menu reuses it.
