//! The one thing telemetry needs from the native side: whether the process
//! was started with it switched off.
//!
//! The webview cannot read the process environment, and the environment is
//! the strongest word on the matter (it beats the choice saved in Settings),
//! so the frontend asks here. Everything else about telemetry — consent,
//! buffering, the events themselves — lives in `src/lib/telemetry/`.

/// The two variables that turn telemetry off: the cross-tool `DO_NOT_TRACK`
/// convention and the app's own. Either one, set to anything but an empty
/// string, `0` or `false`, counts.
const DISABLING_VARS: [&str; 2] = ["DO_NOT_TRACK", "ANYWH_TELEMETRY_DISABLED"];

fn flag_set(value: Option<&str>) -> bool {
    match value.map(|v| v.trim().to_ascii_lowercase()) {
        None => false,
        Some(v) => !(v.is_empty() || v == "0" || v == "false"),
    }
}

fn disabled_by(lookup: impl Fn(&str) -> Option<String>) -> bool {
    DISABLING_VARS.iter().any(|name| flag_set(lookup(name).as_deref()))
}

#[tauri::command]
pub fn telemetry_env_disabled() -> bool {
    disabled_by(|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(vars: &[(&str, &str)]) -> bool {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        disabled_by(|name| map.get(name).cloned())
    }

    #[test]
    fn nothing_set_does_not_disable() {
        assert!(!with(&[]));
    }

    #[test]
    fn either_variable_disables() {
        assert!(with(&[("DO_NOT_TRACK", "1")]));
        assert!(with(&[("ANYWH_TELEMETRY_DISABLED", "1")]));
        assert!(with(&[("DO_NOT_TRACK", "true")]));
    }

    #[test]
    fn empty_zero_and_false_do_not_disable() {
        assert!(!with(&[("DO_NOT_TRACK", "")]));
        assert!(!with(&[("DO_NOT_TRACK", "0")]));
        assert!(!with(&[("ANYWH_TELEMETRY_DISABLED", " False ")]));
    }

    #[test]
    fn one_unset_flag_does_not_cancel_the_other() {
        assert!(with(&[("DO_NOT_TRACK", "0"), ("ANYWH_TELEMETRY_DISABLED", "1")]));
    }
}
