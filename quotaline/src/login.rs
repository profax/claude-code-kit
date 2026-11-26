//! The Claude Code subscription login and the server that reports its limits.
//! The token is read where Claude Code keeps it and is sent to that server
//! only.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

/// Address of the subscription server. `replaced` (the `QUOTALINE_API`
/// variable) swaps in a test server, and only one on this machine: the
/// request carries the login token.
fn api(replaced: Option<String>) -> String {
    replaced
        .filter(|address| address.starts_with("http://127.0.0.1:"))
        .unwrap_or_else(|| "https://api.anthropic.com".into())
}

/// The login record from the macOS keychain, where Claude Code keeps it. The
/// user's keychain lives in their home: a home without one (tests) has no
/// record to ask for.
#[cfg(target_os = "macos")]
fn keychain() -> Option<String> {
    if !std::env::home_dir()?.join("Library/Keychains").is_dir() {
        return None;
    }
    let found = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    found
        .status
        .success()
        .then(|| String::from_utf8_lossy(&found.stdout).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn keychain() -> Option<String> {
    None
}

/// Claude Code's directory: `CLAUDE_CONFIG_DIR`, or `.claude` in the home.
/// An empty variable counts as unset: it would point at whatever directory
/// the program happens to run in.
pub fn config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| Some(std::env::home_dir()?.join(".claude")))
}

/// The subscription login token, or `None` without a subscription login. An
/// expired token is neither returned nor refreshed: Claude Code refreshes it,
/// and a second refresher would leave Claude Code signed out.
pub fn token(now: i64) -> Option<String> {
    let text =
        keychain().or_else(|| fs::read_to_string(config_dir()?.join(".credentials.json")).ok())?;
    let login: Value = serde_json::from_str(&text).ok()?;
    let login = &login["claudeAiOauth"];
    if login["expiresAt"]
        .as_i64()
        .is_some_and(|ms| ms / 1000 <= now)
    {
        return None;
    }
    login["accessToken"].as_str().map(str::to_owned)
}

/// The server's answer about the limits, or `None` when it fails or takes
/// over two seconds: Claude Code shows no line while the program runs.
pub fn ask(token: &str) -> Option<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .into();
    agent
        .get(format!(
            "{}/api/oauth/usage",
            api(std::env::var("QUOTALINE_API").ok())
        ))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .call()
        .ok()?
        .body_mut()
        .read_json()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_goes_only_to_anthropic_or_this_machine() {
        let real = "https://api.anthropic.com";
        assert_eq!(api(None), real);
        assert_eq!(api(Some("https://example.com".into())), real);
        assert_eq!(api(Some("http://127.0.0.1.example.com".into())), real);
        // anything after the port can move the host elsewhere or is no port
        for address in [
            "http://127.0.0.1:1@evil.example/",
            "http://127.0.0.1:8080/",
            "http://127.0.0.1:8080/api",
            "http://127.0.0.1:1#@evil.example",
            "http://127.0.0.1:1?@evil.example",
            "http://127.0.0.1:80\\@evil.example",
            "http://127.0.0.1:",
            "http://127.0.0.1:http",
            "http://127.0.0.1:+80",
        ] {
            assert_eq!(api(Some(address.into())), real, "{address}");
        }
        assert_eq!(
            api(Some("http://127.0.0.1:8080".into())),
            "http://127.0.0.1:8080"
        );
    }
}
