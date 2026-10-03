const COMMANDS: &[&str] = &[
  "show_context_menu",
  "set_top_bar",
  "set_top_bar_menu",
  "set_drawer",
  "set_gesture_hint",
  "set_context_target",
  "set_composer",
  "set_composer_text",
  "focus_composer",
  "blur_composer",
  "set_composer_elapsed",
  "set_scroll_to_end",
  "read_attachment",
  "register_listener",
  "remove_listener",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
