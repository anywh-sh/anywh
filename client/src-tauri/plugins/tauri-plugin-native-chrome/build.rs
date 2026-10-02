const COMMANDS: &[&str] = &[
  "show_context_menu",
  "set_top_bar",
  "set_drawer",
  "set_gesture_hint",
  "register_listener",
  "remove_listener",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
